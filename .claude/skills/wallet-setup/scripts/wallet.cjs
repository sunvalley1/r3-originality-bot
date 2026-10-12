'use strict';

// Secret files are consumed only inside the local signing process, never logged.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  Wallet, Transaction, JsonRpcProvider, FetchRequest, getAddress, hexlify,
  verifyMessage, keccak256, formatUnits,
} = require('ethers');

const chains = { 1: { name: 'Ethereum', gasAsset: 'ETH' },
  100: { name: 'Gnosis', gasAsset: 'xDAI' }, 10: { name: 'Optimism', gasAsset: 'ETH' } };
const defaultConfig = path.resolve('run', 'wallet.json');
let phase = 'startup';
let provider;
let pendingHash;
let lockPath;
let ownsLock = false;
let intentRecorded = false;
let terminalRecorded = false;

class PublicError extends Error {}
function requireThat(condition, message) { if (!condition) throw new PublicError(message); }
function output(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new PublicError('Cannot read the requested local JSON record.'); }
}
function integer(value, field) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value),
    field + ' must be an unsigned integer string in raw units.');
  return BigInt(value);
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value) { return '0x' + crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function writeNew(filename, value) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function append(filename, record) {
  const fd = fs.openSync(filename, 'a', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ ...record, at: new Date().toISOString() }) + '\n');
    fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function protection(mode, payload, directory) {
  requireThat(process.platform === 'win32', 'Bundled encrypted signing requires Windows DPAPI CurrentUser.');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'wallet-protection.ps1'), '-Mode', mode];
  if (directory) args.push('-SecretDirectory', directory);
  const result = spawnSync('powershell.exe', args, { input: payload ? payload.toString('base64') : '',
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 65536, stdio: ['pipe', 'pipe', 'pipe'] });
  requireThat(result.status === 0, 'Windows wallet protection failed; credential details suppressed.');
  if (mode === 'LockDirectory') return;
  const encoded = result.stdout.trim();
  requireThat(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded), 'Unexpected Windows protection response.');
  return Buffer.from(encoded, 'base64');
}
function config(filename = defaultConfig) {
  requireThat(fs.existsSync(filename), 'No public wallet record exists. Run create or select an existing record.');
  const stored = readJson(filename);
  const address = getAddress(stored.address);
  requireThat(getAddress(stored.holder) === address, 'This backend requires holder to equal the local signer EOA.');
  requireThat(typeof stored.keystorePath === 'string' && typeof stored.unlockPath === 'string',
    'Encrypted wallet storage references are missing.');
  const directory = path.dirname(path.resolve(stored.keystorePath));
  const insideFoundry = path.relative(path.join(os.homedir(), '.foundry'), directory);
  requireThat(insideFoundry && !insideFoundry.startsWith('..') && !path.isAbsolute(insideFoundry)
    && path.basename(stored.keystorePath) === 'wallet.json'
    && path.basename(stored.unlockPath) === 'password.dpapi'
    && path.dirname(path.resolve(stored.unlockPath)) === directory,
  'Unsupported encrypted wallet storage layout; no credentials were read.');
  return { ...stored, address, holder: address, configPath: path.resolve(filename) };
}
function publicFacts(stored) {
  return { address: stored.address, holder: stored.address, backend: 'Windows DPAPI CurrentUser encrypted EOA',
    atomicBatches: false, supportedReadChains: [1, 100, 10], supportedSendChains: [1, 100],
    signingVerified: false, broadcast: false };
}
async function unlock(stored) {
  phase = 'unlocking the local signer';
  requireThat(process.platform === 'win32', 'Bundled encrypted signing requires Windows DPAPI CurrentUser.');
  requireThat(!fs.lstatSync(stored.keystorePath).isSymbolicLink()
    && !fs.lstatSync(stored.unlockPath).isSymbolicLink(), 'Credential file links are unsupported.');
  const password = protection('Unprotect', fs.readFileSync(stored.unlockPath));
  try {
    const wallet = await Wallet.fromEncryptedJson(fs.readFileSync(stored.keystorePath, 'utf8'), password);
    requireThat(wallet.address === stored.address, 'Recovered signer does not match the public address.');
    return wallet;
  } finally { password.fill(0); }
}
async function proof(wallet, chainId) {
  const message = 'agent-wallet possession check, not spending authorization: ' + crypto.randomUUID();
  requireThat(getAddress(verifyMessage(message, await wallet.signMessage(message))) === wallet.address,
    'Offline message signature recovery failed.');
  const signed = await wallet.signTransaction({ chainId, type: 0, nonce: 0, to: wallet.address,
    value: 0n, data: '0x', gasLimit: 21000n, gasPrice: 1n });
  const recovered = Transaction.from(signed);
  requireThat(recovered.from === wallet.address && recovered.chainId === BigInt(chainId),
    'Offline transaction signature recovery failed.');
}
async function create(filename) {
  phase = 'creating or reusing the encrypted wallet';
  requireThat(process.platform === 'win32', 'Bundled wallet creation requires Windows DPAPI; use a verified encrypted backend on this OS.');
  if (fs.existsSync(filename)) {
    const stored = config(filename);
    await proof(await unlock(stored), 1);
    return output({ ...publicFacts(stored), existing: true, signingVerified: true,
      signingVerificationScope: 'offline chain 1 only; no RPC or funds verified' });
  }
  const directory = path.join(os.homedir(), '.foundry', 'agent-wallet');
  requireThat(!fs.existsSync(directory) || fs.readdirSync(directory).length === 0,
    'Credential storage exists without this public record. Refusing to overwrite or rotate it.');
  fs.mkdirSync(directory, { recursive: true });
  protection('LockDirectory', null, directory);
  const key = crypto.randomBytes(32), password = crypto.randomBytes(32);
  try {
    const wallet = new Wallet(hexlify(key));
    key.fill(0);
    const stored = { address: wallet.address, holder: wallet.address,
      keystorePath: path.join(directory, 'wallet.json'), unlockPath: path.join(directory, 'password.dpapi'),
      signerMode: 'Windows DPAPI CurrentUser encrypted EOA', createdAt: new Date().toISOString() };
    const encrypted = await wallet.encrypt(password);
    writeNew(stored.unlockPath, protection('Protect', password));
    writeNew(stored.keystorePath, encrypted);
    await proof(await unlock(stored), 1);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    writeNew(filename, JSON.stringify(stored, null, 2) + '\n');
    output({ ...publicFacts(stored), existing: false, signingVerified: true,
      signingVerificationScope: 'offline chain 1 only; no RPC or funds verified' });
  } finally { key.fill(0); password.fill(0); }
}
function request(filename) {
  requireThat(filename, 'Provide a public chain request or exact transaction plan JSON path.');
  const file = path.resolve(filename), value = readJson(file);
  requireThat(value && typeof value === 'object' && !Array.isArray(value) && chains[value.chainId],
    'Specify chainId 1, 100 or 10 as a number.');
  requireThat(typeof value.chainId === 'number', 'chainId must be a number.');
  let url;
  try { url = new URL(value.rpcUrl); } catch { throw new PublicError('Specify an explicit HTTPS RPC in the local request.'); }
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.hash,
    'RPC must use HTTPS without URL username, password or fragment.');
  return { value, file, stored: config(value.walletConfig
    ? path.resolve(path.dirname(file), value.walletConfig) : defaultConfig) };
}
async function connect(value) {
  phase = 'verifying the selected RPC network';
  const rpc = new FetchRequest(value.rpcUrl);
  rpc.timeout = 8000; rpc.retryFunc = () => false;
  provider = new JsonRpcProvider(rpc, value.chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  requireThat(BigInt(await provider.send('eth_chainId', [])) === BigInt(value.chainId),
    'RPC chain does not match the explicit request.');
  const block = await provider.getBlock('latest');
  requireThat(block && block.hash, 'RPC did not return a complete latest block.');
  return block;
}
function ledgerFile(stored) { return path.join(path.dirname(stored.configPath), 'wallet-transactions.jsonl'); }
function ledger(stored) {
  const file = ledgerFile(stored);
  if (!fs.existsSync(file)) return [];
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch { throw new PublicError('Transaction ledger is unreadable; reconcile it before spending.'); }
}
function unresolved(rows) {
  const states = new Map();
  for (const row of rows) if (row.hash) states.set(row.hash, row.event);
  return [...states.entries()].filter(([, event]) => event !== 'confirmed' && event !== 'reverted');
}
function mandateFor(plan, filename, rows) {
  requireThat(typeof plan.mandateFile === 'string', 'Record an authorized local mandate before spending.');
  const mandate = readJson(path.resolve(path.dirname(filename), plan.mandateFile));
  const mandateDigest = digest(mandate);
  requireThat(plan.mandateDigest === mandateDigest, 'The transaction plan does not match its recorded mandate digest.');
  requireThat(mandate && typeof mandate.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(mandate.id)
    && typeof mandate.authorizationSource === 'string' && mandate.authorizationSource.length > 0
    && ['delegated', 'per-plan'].includes(mandate.mode), 'Mandate identity or authorization source is missing.');
  const expiry = Date.parse(mandate.expiresAt), authorizedAt = Date.parse(mandate.authorizedAt);
  requireThat(Number.isFinite(expiry) && Number.isFinite(authorizedAt) && authorizedAt <= Date.now()
    && expiry > Date.now(), 'Mandate is expired or has invalid authorization timestamps.');
  requireThat(Array.isArray(mandate.authorizedChains) && mandate.authorizedChains.includes(plan.chainId)
    && Array.isArray(mandate.tasks) && mandate.tasks.includes(plan.task), 'Task or chain is outside the mandate.');
  requireThat(Array.isArray(mandate.allowedRecipients)
    && mandate.allowedRecipients.map(getAddress).includes(getAddress(plan.to)), 'Recipient is outside the mandate.');
  requireThat(Number.isSafeInteger(mandate.maxTransactions) && mandate.maxTransactions > 0,
    'Mandate needs a positive transaction count limit.');
  requireThat(plan.atomicRequired === false && typeof plan.reviewedAction === 'string'
    && plan.reviewedAction.length > 0, 'Record the decoded action and atomicRequired:false; this EOA has no atomic batch capability.');
  if (mandate.mode === 'per-plan') requireThat(Array.isArray(mandate.approvedTransactionHashes)
    && mandate.approvedTransactionHashes.includes(plan.transactionHash), 'Exact transaction has no recorded per-plan approval.');
  const prior = rows.filter(row => row.event === 'broadcast-intent' && row.mandateId === mandate.id);
  requireThat(prior.every(row => row.mandateDigest === mandateDigest), 'An existing mandate ID was changed; use its original recorded scope.');
  requireThat(prior.length < mandate.maxTransactions, 'Mandate transaction count is exhausted.');
  const limits = mandate.budgets && mandate.budgets[String(plan.chainId)];
  requireThat(limits && Array.isArray(limits.tokenLimits), 'Mandate needs explicit native and token limits for this chain.');
  return { mandate, mandateDigest, limits, prior: prior.filter(row => row.chainId === plan.chainId) };
}
function exposureFor(plan, fee, auth) {
  const value = integer(plan.valueWei, 'valueWei');
  const exposure = plan.exposure;
  requireThat(exposure && Array.isArray(exposure.tokens), 'Record decoded native and token exposure.');
  const deposit = integer(exposure.nativeDepositWei, 'nativeDepositWei');
  const loss = integer(exposure.nativeLossWei, 'nativeLossWei');
  requireThat(deposit <= value && loss >= value, 'Native deposit/loss exposure does not cover the sent value.');
  const totals = [
    ['maxTotalNativeSpendWei', value + fee, 'nativeSpendWei'],
    ['maxTotalFeeWei', fee, 'feeWei'], ['maxTotalValueWei', value, 'valueWei'],
    ['maxTotalDepositWei', deposit, 'nativeDepositWei'], ['maxTotalLossWei', loss + fee, 'nativeLossWei'],
  ];
  const charges = {};
  for (const [limit, amount, key] of totals) {
    const used = auth.prior.reduce((sum, row) => sum + integer(row.charges[key], key), 0n);
    requireThat(used + amount <= integer(auth.limits[limit], limit), 'Mandate cumulative ' + limit + ' would be exceeded.');
    charges[key] = amount.toString();
  }
  charges.tokens = [];
  const seen = new Set();
  for (const token of exposure.tokens) {
    const address = getAddress(token.address);
    requireThat(!seen.has(address), 'Duplicate token exposure is unsupported.'); seen.add(address);
    const limit = auth.limits.tokenLimits.find(item => getAddress(item.address) === address);
    requireThat(limit, 'Token exposure is outside the mandate.');
    const charge = { address };
    for (const key of ['spendRaw', 'depositRaw', 'lossRaw', 'approvalRaw']) {
      const amount = integer(token[key], key);
      const used = auth.prior.reduce((sum, row) => sum + (row.charges.tokens || []).reduce((subtotal, item) =>
        subtotal + (getAddress(item.address) === address ? integer(item[key], key) : 0n), 0n), 0n);
      requireThat(used + amount <= integer(limit[key], key), 'Mandate cumulative token ' + key + ' would be exceeded.');
      charge[key] = amount.toString();
    }
    requireThat(BigInt(charge.depositRaw) <= BigInt(charge.spendRaw)
      && BigInt(charge.lossRaw) >= BigInt(charge.spendRaw) + BigInt(charge.approvalRaw),
    'Token deposit/loss exposure does not cover spending and approval authority.');
    charges.tokens.push(charge);
  }
  return charges;
}
function transactionFor(plan) {
  requireThat(typeof plan.chainId === 'number' && chains[plan.chainId], 'Specify chainId 1, 100 or 10.');
  requireThat(Number.isSafeInteger(plan.nonce) && plan.nonce >= 0, 'Plan nonce must be a nonnegative integer.');
  requireThat(typeof plan.data === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(plan.data), 'Plan calldata must be an explicit byte string.');
  return { chainId: plan.chainId, type: 0, nonce: plan.nonce, to: getAddress(plan.to), data: plan.data,
    value: integer(plan.valueWei, 'valueWei'), gasLimit: integer(plan.gasLimit, 'gasLimit'), gasPrice: integer(plan.gasPriceWei, 'gasPriceWei') };
}
async function prepare(plan, filename, stored, rows) {
  phase = 'checking the exact authorized transaction';
  requireThat(getAddress(plan.from) === stored.address, 'Plan sender does not match the local wallet.');
  const tx = transactionFor(plan);
  const caps = plan.caps;
  requireThat(caps && tx.gasLimit > 0n && tx.gasPrice > 0n
    && tx.gasLimit <= integer(caps.maxGasLimit, 'maxGasLimit')
    && tx.gasPrice <= integer(caps.maxGasPriceWei, 'maxGasPriceWei')
    && tx.value <= integer(caps.maxValueWei, 'maxValueWei'), 'Transaction gas/value limits are exceeded.');
  if (plan.chainId === 10) requireThat(tx.gasLimit <= 16777216n, 'Optimism transaction gas exceeds 2^24.');
  const fee = tx.gasLimit * tx.gasPrice;
  requireThat(fee <= integer(caps.maxFeeWei, 'maxFeeWei'), 'Transaction execution fee cap is exceeded.');
  const transactionHash = Transaction.from(tx).unsignedHash;
  requireThat(plan.transactionHash === transactionHash, 'Exact unsigned transaction hash does not match the reviewed plan.');
  const auth = mandateFor(plan, filename, rows);
  const charges = exposureFor(plan, fee, auth);
  requireThat(unresolved(rows).length === 0, 'A prior transaction intent is unresolved. Reconcile its logged hash before spending.');
  const [pendingNonce, latestNonce, code, balance, suggestedPrice] = await Promise.all([
    provider.getTransactionCount(stored.address, 'pending'), provider.getTransactionCount(stored.address, 'latest'),
    provider.getCode(stored.address, 'latest'), provider.getBalance(stored.address, 'pending'), provider.send('eth_gasPrice', []),
  ]);
  requireThat(code === '0x', 'Configured signer has contract code; this backend supports an EOA only.');
  requireThat(pendingNonce === latestNonce && pendingNonce === tx.nonce, 'Pending nonce conflict; do not alter or reuse this plan automatically.');
  requireThat(BigInt(suggestedPrice) <= tx.gasPrice, 'Current suggested gas price exceeds the exact planned gas price.');
  requireThat(balance >= tx.value + fee, 'Native balance is insufficient for value plus maximum execution gas.');
  phase = 'simulating the exact transaction';
  await provider.call({ ...tx, from: stored.address });
  requireThat(await provider.estimateGas({ ...tx, from: stored.address }) <= tx.gasLimit,
    'Exact planned gas limit is below the fresh estimate.');
  const summary = { chainId: plan.chainId, network: chains[plan.chainId].name, nativeGasAsset: chains[plan.chainId].gasAsset,
    from: stored.address, to: tx.to, nonce: tx.nonce, data: tx.data, valueWei: tx.value.toString(),
    gasLimit: tx.gasLimit.toString(), gasPriceWei: tx.gasPrice.toString(), executionFeeUpperBoundWei: fee.toString(),
    transactionHash, mandateId: auth.mandate.id, mandateDigest: auth.mandateDigest,
    mandateExpiresAt: auth.mandate.expiresAt, task: plan.task,
    reviewedAction: plan.reviewedAction, charges, atomicBatches: false, simulationPassed: true,
    totalFeeCapEnforceable: plan.chainId !== 10,
    feeNote: plan.chainId === 10 ? 'L1 data and operator fees are additional; this helper refuses OP broadcast.'
      : 'Fixed legacy gas price times gasLimit caps the native execution fee; semantic token/deposit exposure still requires ABI review.' };
  return { tx, summary, confirmations: auth.mandate.confirmations ?? 2 };
}
function releaseLock() {
  if (ownsLock && (!intentRecorded || terminalRecorded)) {
    try { fs.unlinkSync(lockPath); ownsLock = false; }
    catch { output({ ok: false, status: 'lock-review-required', message: 'Sender lock could not be released. Review recorded state before retrying.' }); process.exitCode = 1; }
  }
}
function record(stored, summary, event, extra = {}) {
  append(ledgerFile(stored), { event, hash: pendingHash, ...summary, ...extra });
}
async function send(plan, filename, stored) {
  requireThat(plan.chainId !== 10, 'OP L1 data fees cannot be hard capped by this transaction format; this helper does not broadcast on chain 10.');
  lockPath = path.join(path.dirname(stored.configPath), 'wallet-send.lock');
  try { writeNew(lockPath, JSON.stringify({ pid: process.pid, chainId: plan.chainId, startedAt: new Date().toISOString() })); ownsLock = true; }
  catch { throw new PublicError('A sender lock exists or cannot be created. Reconcile prior hashes before clearing a stale lock.'); }
  const { tx, summary, confirmations } = await prepare(plan, filename, stored, ledger(stored));
  requireThat(Number.isSafeInteger(confirmations) && confirmations >= 2 && confirmations <= 100,
    'Mandate confirmations must be between 2 and 100.');
  const wallet = await unlock(stored);
  const signed = await wallet.signTransaction(tx);
  const recovered = Transaction.from(signed);
  requireThat(recovered.from === stored.address && recovered.unsignedHash === summary.transactionHash,
    'Signed transaction differs from the exact simulated plan.');
  requireThat(await provider.getTransactionCount(stored.address, 'pending') === tx.nonce,
    'Nonce changed while signing; the exact plan was not broadcast.');
  requireThat(Date.parse(summary.mandateExpiresAt) > Date.now()
    && digest(readJson(path.resolve(path.dirname(filename), plan.mandateFile))) === summary.mandateDigest,
  'Mandate expired or changed while signing; the exact plan was not broadcast.');
  pendingHash = keccak256(signed);
  // Persist before any RPC broadcast. Never store or output the signed bytes.
  record(stored, summary, 'broadcast-intent', { confirmations }); intentRecorded = true;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, chainId: plan.chainId, hash: pendingHash }));
  output({ ...summary, hash: pendingHash, status: 'broadcast-intent-recorded' });
  phase = 'broadcasting the recorded transaction';
  const response = await provider.broadcastTransaction(signed);
  requireThat(response.hash === pendingHash, 'RPC broadcast response hash is unexpected; reconcile the recorded hash.');
  record(stored, summary, 'broadcast-accepted', { confirmations });
  const receipt = await provider.waitForTransaction(pendingHash, confirmations, 45000);
  requireThat(receipt, 'Receipt wait timed out; the hash and sender lock remain for reconciliation.');
  requireThat(receipt.hash === pendingHash && [0, 1].includes(receipt.status),
    'Receipt hash or status is incomplete; reconcile the recorded hash before retrying.');
  const event = receipt.status === 1 ? 'confirmed' : 'reverted';
  record(stored, summary, event, { confirmations, blockNumber: receipt.blockNumber }); terminalRecorded = true;
  output({ hash: pendingHash, chainId: plan.chainId, status: event, blockNumber: receipt.blockNumber,
    confirmations, finality: 'not-proven', atomicBatches: false });
  if (event === 'reverted') process.exitCode = 1;
}
async function reconcile(value, stored) {
  requireThat(typeof value.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value.hash), 'Provide the recorded transaction hash.');
  const rows = ledger(stored), intent = rows.find(row => row.hash === value.hash && row.event === 'broadcast-intent');
  requireThat(intent && intent.chainId === value.chainId && getAddress(intent.from) === stored.address,
    'Hash is not a recorded intent for this signer and requested chain.');
  const receipt = await provider.getTransactionReceipt(value.hash);
  if (!receipt) return output({ hash: value.hash, chainId: value.chainId, status: 'unresolved',
    retryBroadcast: false, message: 'No receipt observed. Do not infer non-broadcast or reuse the nonce.' });
  requireThat(receipt.hash === value.hash && [0, 1].includes(receipt.status),
    'Receipt hash or status does not match the recorded intent.');
  const tx = await provider.getTransaction(value.hash);
  requireThat(tx && tx.hash === value.hash && BigInt(tx.chainId) === BigInt(value.chainId)
    && getAddress(tx.from) === stored.address && tx.nonce === intent.nonce,
    'Receipt sender/nonce do not match the recorded intent.');
  const confirmations = intent.confirmations ?? 2;
  if (await receipt.confirmations() < confirmations) return output({ hash: value.hash, status: 'pending-confirmations', retryBroadcast: false });
  const event = receipt.status === 1 ? 'confirmed' : 'reverted';
  append(ledgerFile(stored), { ...intent, event, blockNumber: receipt.blockNumber });
  const file = path.join(path.dirname(stored.configPath), 'wallet-send.lock');
  let lockRetained = false;
  if (fs.existsSync(file)) {
    const lock = readJson(file);
    if (lock.hash === value.hash && lock.chainId === value.chainId) {
      let live = false;
      try { process.kill(lock.pid, 0); live = true; } catch { /* absent process; no signal sent */ }
      if (live) lockRetained = true; else fs.unlinkSync(file);
    } else lockRetained = true;
  }
  output({ hash: value.hash, chainId: value.chainId, status: event, confirmations,
    lockRetained, retryBroadcast: false, finality: 'not-proven' });
}
async function main() {
  const [command = 'info', filename, broadcast, ...extra] = process.argv.slice(2);
  requireThat(extra.length === 0, 'Unexpected command arguments. Secrets are never command arguments.');
  if (command === 'digest') { requireThat(filename && !broadcast, 'Provide one local public JSON path.'); return output({ digest: digest(readJson(path.resolve(filename))) }); }
  if (command === 'transaction-hash') {
    requireThat(filename && !broadcast, 'Provide one local exact transaction plan JSON path.');
    return output({ transactionHash: Transaction.from(transactionFor(readJson(path.resolve(filename)))).unsignedHash });
  }
  if (command === 'create' || command === 'info') {
    requireThat(!broadcast, 'Unexpected wallet setup argument.');
    const file = filename ? path.resolve(filename) : defaultConfig;
    return command === 'create' ? create(file) : output(publicFacts(config(file)));
  }
  requireThat(['verify', 'balance', 'simulate', 'send', 'reconcile'].includes(command), 'Unknown wallet command.');
  requireThat(command === 'send' ? broadcast === '--broadcast' : !broadcast,
    'Only an explicitly authorized send uses --broadcast.');
  const { value, file, stored } = request(filename);
  if (command === 'verify') {
    await proof(await unlock(stored), value.chainId);
    return output({ ...publicFacts(stored), chainId: value.chainId, signingVerified: true,
      messageSigningVerified: true, offlineTransactionSigningVerified: true, rpcNetworkVerified: false });
  }
  const block = await connect(value);
  if (command === 'balance') {
    const [code, balance] = await Promise.all([provider.getCode(stored.address, block.number), provider.getBalance(stored.address, block.number)]);
    requireThat(code === '0x', 'Configured address has contract code; this backend supports an EOA only.');
    return output({ ...publicFacts(stored), chainId: value.chainId, network: chains[value.chainId].name,
      rpcNetworkVerified: true, nativeGasAsset: chains[value.chainId].gasAsset, nativeBalanceRaw: balance.toString(),
      nativeBalance: formatUnits(balance, 18), status: balance === 0n ? 'needs-funding' : 'funds-observed',
      executionReady: false, readAt: { observedAt: new Date().toISOString(), blockNumber: block.number, blockHash: block.hash } });
  }
  if (command === 'reconcile') return reconcile(value, stored);
  if (command === 'simulate') return output((await prepare(value, file, stored, ledger(stored))).summary);
  return send(value, file, stored);
}
const deadline = setTimeout(() => {
  output({ ok: false, status: pendingHash ? 'reconciliation-required' : 'incomplete', hash: pendingHash ?? null,
    message: 'Wallet helper timed out. Credential details suppressed. Reconcile any recorded hash before retrying.' });
  if (provider) provider.destroy();
  // An unresolved broadcast retains its lock. A pre-broadcast timeout has no nonce commitment.
  releaseLock(); process.exit(1);
}, 60000);
main().catch(error => {
  output({ ok: false, status: pendingHash ? 'reconciliation-required' : 'incomplete', hash: pendingHash ?? null,
    message: error instanceof PublicError ? error.message : 'Wallet helper failed during ' + phase + '; credential details suppressed.' });
  process.exitCode = 1;
}).finally(() => { clearTimeout(deadline); if (provider) provider.destroy(); releaseLock(); });

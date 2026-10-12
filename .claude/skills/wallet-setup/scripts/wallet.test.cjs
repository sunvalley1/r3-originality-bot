'use strict';

// Isolated public-control tests. All credentials, signing and RPC are mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ethers = require('ethers');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, 'wallet.cjs'), 'utf8');
const signer = ethers.getAddress('0x0000000000000000000000000000000000000001');
const recipient = ethers.getAddress('0x0000000000000000000000000000000000000002');
const home = 'C:\\Agent';
const configPath = path.resolve('run', 'wallet.json');
const requestFile = path.resolve('run', 'request.json');
const mandateFile = path.resolve('run', 'mandate.json');
const ledgerFile = path.resolve('run', 'wallet-transactions.jsonl');
const lockFile = path.resolve('run', 'wallet-send.lock');
const keystore = path.join(home, '.foundry', 'agent-wallet', 'wallet.json');
const password = path.join(home, '.foundry', 'agent-wallet', 'password.dpapi');
const stored = { address: signer, holder: signer, keystorePath: keystore, unlockPath: password };
let scenarioCount = 0;
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value) { return '0x' + crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function fixtures(chainId = 100) {
  const limits = { maxTotalNativeSpendWei: '1000000', maxTotalFeeWei: '500000',
    maxTotalValueWei: '500000', maxTotalDepositWei: '500000', maxTotalLossWei: '1000000', tokenLimits: [] };
  const mandate = { id: 'test-mandate', authorizationSource: 'Trusted human request in isolated fixture',
    authorizedAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    mode: 'delegated', authorizedChains: [chainId], tasks: ['test-task'], allowedRecipients: [recipient],
    maxTransactions: 3, confirmations: 2, budgets: { [chainId]: limits } };
  const plan = { chainId, rpcUrl: 'https://public.example/rpc', task: 'test-task', from: signer, to: recipient,
    data: '0x', valueWei: '1000', nonce: 0, gasLimit: '25200', gasPriceWei: '1',
    caps: { maxGasLimit: '25200', maxGasPriceWei: '1', maxValueWei: '1000', maxFeeWei: '25200' },
    atomicRequired: false, reviewedAction: 'A bounded fixture action', mandateFile: './mandate.json',
    exposure: { nativeDepositWei: '0', nativeLossWei: '1000', tokens: [] } };
  const tx = { chainId, type: 0, nonce: 0, to: recipient, data: '0x', value: 1000n, gasLimit: 25200n, gasPrice: 1n };
  plan.transactionHash = ethers.Transaction.from(tx).unsignedHash;
  plan.mandateDigest = digest(mandate);
  return { plan, mandate, tx };
}
async function run(command, options = {}) {
  scenarioCount++;
  const fixture = fixtures(options.chainId || (command === 'create' ? 1 : 100));
  if (options.mutateMandate) options.mutateMandate(fixture.mandate);
  fixture.plan.mandateDigest = digest(fixture.mandate);
  if (options.mutatePlan) options.mutatePlan(fixture.plan);
  const files = new Map([[configPath, JSON.stringify(stored)], [requestFile, JSON.stringify(fixture.plan)],
    [mandateFile, JSON.stringify(fixture.mandate)], [keystore, 'MOCK_ENCRYPTED_KEYSTORE'], [password, Buffer.from('MOCK_DPAPI_DATA')]]);
  if (options.missingConfig) files.delete(configPath);
  if (options.newCreate) { files.delete(configPath); files.delete(keystore); files.delete(password); }
  if (options.config) files.set(configPath, JSON.stringify(options.config));
  if (options.rows) files.set(ledgerFile, (typeof options.rows === 'function' ? options.rows(fixture) : options.rows)
    .map(row => JSON.stringify(row)).join('\n') + '\n');
  if (options.existingLock) files.set(lockFile, JSON.stringify({ pid: 99999 }));
  if (command === 'reconcile') {
    fixture.plan.hash = ethers.keccak256('0xdeadbeef');
    files.set(requestFile, JSON.stringify(fixture.plan));
    if (options.reconcileLock) files.set(lockFile, JSON.stringify({ pid: 99999, chainId: fixture.plan.chainId, hash: fixture.plan.hash }));
  }
  let output = '', deadline, credentialReads = 0, broadcasts = 0, signatures = 0;
  const descriptors = new Map(); let nextDescriptor = 1;
  const mockFs = {
    existsSync: filename => files.has(filename) || (options.orphanDirectory && filename === path.dirname(keystore)),
    mkdirSync: () => {}, readdirSync: () => ['wallet.json'],
    readFileSync: filename => { if (filename === keystore || filename === password) credentialReads++;
      assert.ok(files.has(filename), 'unexpected mocked file read'); return files.get(filename); },
    lstatSync: () => ({ isSymbolicLink: () => false }),
    openSync: (filename, flags) => { if (flags === 'wx' && files.has(filename)) throw new Error('exists');
      if (!files.has(filename)) files.set(filename, ''); const fd = nextDescriptor++; descriptors.set(fd, { filename, flags }); return fd; },
    writeFileSync: (target, value) => { if (typeof target === 'number') {
      const entry = descriptors.get(target); files.set(entry.filename, entry.flags === 'a' ? files.get(entry.filename) + value : value);
    } else files.set(target, value); },
    fsyncSync: () => {}, closeSync: () => {}, unlinkSync: filename => files.delete(filename),
  };
  class Provider {
    async send(method) { if (options.rpcError) throw new Error('RPC_URL_SECRET');
      if (options.hang) return new Promise(() => {});
      return method === 'eth_chainId' ? ethers.toQuantity(options.wrongChain ? 1 : fixture.plan.chainId) : '0x1'; }
    async getBlock() { return { number: 100, hash: '0xblock' }; }
    async getCode() { return options.contractHolder ? '0x1234' : '0x'; }
    async getBalance() { return options.zeroBalance ? 0n : 1000000000n; }
    async getTransactionCount(_, tag) { return options.nonceConflict && tag === 'pending' ? 1 : 0; }
    async call(tx) { assert.equal(tx.nonce, fixture.plan.nonce); assert.equal(tx.gasLimit.toString(), fixture.plan.gasLimit);
      if (options.revertSimulation) throw new Error('SIMULATION_PRIVATE_DETAIL'); return '0x'; }
    async estimateGas() { return options.highEstimate ? 50000n : 21000n; }
    async broadcastTransaction() { broadcasts++;
      assert.ok(files.get(ledgerFile).includes('broadcast-intent'), 'intent must precede RPC broadcast');
      assert.ok(files.has(lockFile), 'sender lock must precede broadcast');
      if (options.broadcastError) throw new Error('RPC_BROADCAST_SECRET');
      return { hash: ethers.keccak256('0xdeadbeef') }; }
    async waitForTransaction() { return options.receiptTimeout ? null : { hash: ethers.keccak256('0xdeadbeef'),
      status: options.incompleteReceipt ? null : options.revertReceipt ? 0 : 1, blockNumber: 101 }; }
    async getTransactionReceipt() { return options.missingReceipt ? null : { hash: fixture.plan.hash, status: 1, blockNumber: 101,
      confirmations: async () => options.lowConfirmations ? 1 : 2 }; }
    async getTransaction() { return { hash: fixture.plan.hash, chainId: BigInt(fixture.plan.chainId),
      from: options.wrongReceiptSender ? recipient : signer, nonce: 0 }; }
    destroy() {}
  }
  class MockWallet {
    static async fromEncryptedJson() { return new MockWallet(); }
    get address() { return signer; }
    async signMessage() { signatures++; return 'mock-message-signature'; }
    async signTransaction() { signatures++; if (options.changeMandateWhileSigning)
      files.set(mandateFile, JSON.stringify({ ...fixture.mandate, expiresAt: '2000-01-01' })); return '0xdeadbeef'; }
    async encrypt() { return 'MOCK_ENCRYPTED_KEYSTORE'; }
  }
  const fakeEthers = { ...ethers, Wallet: MockWallet, JsonRpcProvider: Provider, FetchRequest: class {},
    verifyMessage: () => signer,
    Transaction: { from: tx => typeof tx === 'string'
      ? { from: signer, chainId: BigInt(fixture.plan.chainId), unsignedHash: fixture.plan.transactionHash }
      : ethers.Transaction.from(tx) } };
  const mockProcess = { platform: options.otherOS ? 'linux' : 'win32', pid: 111,
    argv: ['node', 'wallet.cjs', command, requestFile, ...(command === 'send' ? ['--broadcast'] : [])],
    stdout: { write: text => { output += text; } }, exitCode: 0, exit: code => { mockProcess.exitCode = code; },
    kill: (_, signal) => { assert.equal(signal, 0); if (!options.liveOwner) throw new Error('absent'); } };
  if (command === 'info' || command === 'create') mockProcess.argv = ['node', 'wallet.cjs', command, configPath];
  vm.runInNewContext(source, { require: name => name === 'node:fs' ? mockFs : name === 'node:os' ? { homedir: () => home }
    : name === 'node:child_process' ? { spawnSync: (_, args) => { assert.ok(!args.some(arg => arg.includes('MOCK')));
      return { status: 0, stdout: Buffer.from('MOCK_UNLOCK_PASSWORD').toString('base64') }; } }
      : name === 'ethers' ? fakeEthers : require(name), __dirname, process: mockProcess, URL, Buffer,
    setTimeout: (callback, delay) => { assert.equal(delay, 60000); deadline = callback; return 1; }, clearTimeout: () => {} });
  await new Promise(resolve => setImmediate(resolve));
  if (options.hang) { assert.equal(output, ''); deadline(); }
  const objects = []; let depth = 0, start = 0;
  // Every helper output is pretty JSON followed by a newline; split complete top-level records.
  for (let i = 0; i < output.length; i++) {
    if (output[i] === '{') { if (!depth) start = i; depth++; }
    if (output[i] === '}' && --depth === 0) objects.push(JSON.parse(output.slice(start, i + 1)));
  }
  assert.ok(objects.length, 'expected structured public output');
  assert.ok(!output.includes('RPC_URL_SECRET') && !output.includes('RPC_BROADCAST_SECRET')
    && !output.includes('MOCK_UNLOCK_PASSWORD') && !output.includes('MOCK_ENCRYPTED_KEYSTORE'));
  return { objects, files, credentialReads, broadcasts, signatures, exitCode: mockProcess.exitCode };
}
async function main() {
  for (const chainId of [1, 100, 10]) {
    const balance = await run('balance', { chainId, zeroBalance: true });
    assert.equal(balance.objects[0].nativeBalanceRaw, '0'); assert.equal(balance.objects[0].status, 'needs-funding');
    assert.equal(balance.objects[0].nativeGasAsset, chainId === 100 ? 'xDAI' : 'ETH'); assert.equal(balance.credentialReads, 0);
    const verify = await run('verify', { chainId }); assert.equal(verify.objects[0].offlineTransactionSigningVerified, true);
    assert.equal(verify.objects[0].rpcNetworkVerified, false); assert.equal(verify.broadcasts, 0);
    const simulate = await run('simulate', { chainId }); assert.equal(simulate.objects[0].simulationPassed, true);
    assert.equal(simulate.credentialReads, 0); assert.equal(simulate.signatures, 0); assert.equal(simulate.broadcasts, 0);
  }
  for (const chainId of [1, 100]) {
    const sent = await run('send', { chainId }); assert.equal(sent.objects.at(-1).status, 'confirmed');
    assert.equal(sent.broadcasts, 1); assert.ok(!sent.files.has(lockFile));
  }
  const op = await run('send', { chainId: 10 }); assert.equal(op.broadcasts, 0); assert.equal(op.credentialReads, 0);
  const timed = await run('send', { receiptTimeout: true }); assert.equal(timed.objects.at(-1).status, 'reconciliation-required'); assert.ok(timed.files.has(lockFile));
  const ambiguous = await run('send', { broadcastError: true }); assert.equal(ambiguous.broadcasts, 1); assert.ok(ambiguous.files.has(lockFile));
  const incomplete = await run('send', { incompleteReceipt: true });
  assert.equal(incomplete.objects.at(-1).status, 'reconciliation-required'); assert.ok(incomplete.files.has(lockFile));
  const reverted = await run('send', { revertReceipt: true }); assert.equal(reverted.objects.at(-1).status, 'reverted'); assert.equal(reverted.exitCode, 1);
  for (const options of [
    { missingConfig: true }, { wrongChain: true }, { rpcError: true }, { contractHolder: true }, { nonceConflict: true },
    { revertSimulation: true }, { highEstimate: true }, { zeroBalance: true }, { existingLock: true },
    { mutatePlan: plan => { plan.transactionHash = '0xbad'; } },
    { mutatePlan: plan => { plan.atomicRequired = true; } },
    { mutatePlan: plan => { plan.caps.maxFeeWei = '1'; } },
    { mutatePlan: plan => { plan.mandateDigest = '0xbad'; } },
    { mutateMandate: mandate => { mandate.expiresAt = '2000-01-01'; } },
    { mutateMandate: mandate => { mandate.tasks = ['another-task']; } },
    { mutateMandate: mandate => { mandate.allowedRecipients = []; } },
    { mutateMandate: mandate => { mandate.budgets['100'].maxTotalNativeSpendWei = '1'; } },
    { mutateMandate: mandate => { mandate.mode = 'per-plan'; mandate.approvedTransactionHashes = []; } },
  ]) {
    const result = await run('send', options); assert.equal(result.exitCode, 1); assert.equal(result.broadcasts, 0); assert.equal(result.credentialReads, 0);
  }
  const unknown = await run('balance', { rpcError: true }); assert.equal(unknown.objects[0].ok, false);
  assert.equal(unknown.objects[0].nativeBalanceRaw, undefined); assert.equal(unknown.credentialReads, 0);
  const hung = await run('balance', { hang: true }); assert.equal(hung.exitCode, 1); assert.equal(hung.credentialReads, 0);
  const unsupported = await run('verify', { otherOS: true }); assert.equal(unsupported.exitCode, 1); assert.equal(unsupported.broadcasts, 0);
  assert.equal(unsupported.credentialReads, 0);
  const reused = await run('create'); assert.equal(reused.objects[0].existing, true); assert.equal(reused.broadcasts, 0);
  const created = await run('create', { newCreate: true }); assert.equal(created.objects[0].existing, false);
  assert.ok(created.files.has(configPath)); assert.ok(created.files.has(keystore)); assert.ok(created.files.has(password)); assert.equal(created.broadcasts, 0);
  const orphan = await run('create', { newCreate: true, orphanDirectory: true });
  assert.equal(orphan.exitCode, 1); assert.equal(orphan.credentialReads, 0); assert.equal(orphan.signatures, 0);
  const publicInfo = await run('info'); assert.equal(publicInfo.credentialReads, 0); assert.equal(publicInfo.objects[0].signingVerified, false);
  const exhausted = await run('send', { rows: fixture => [{ event: 'broadcast-intent', hash: ethers.keccak256('0x1234'),
    mandateId: fixture.mandate.id, mandateDigest: fixture.plan.mandateDigest, chainId: fixture.plan.chainId,
    charges: { nativeSpendWei: '1000000', feeWei: '500000', valueWei: '500000', nativeDepositWei: '0', nativeLossWei: '1000000', tokens: [] } },
  { event: 'confirmed', hash: ethers.keccak256('0x1234') }] });
  assert.equal(exhausted.exitCode, 1); assert.equal(exhausted.broadcasts, 0);
  const unresolved = await run('send', { rows: [{ event: 'broadcast-intent', hash: ethers.keccak256('0x1234') }] });
  assert.equal(unresolved.exitCode, 1); assert.equal(unresolved.broadcasts, 0);
  const separateChainBudget = await run('send', { mutateMandate: mandate => { mandate.authorizedChains.push(1);
    mandate.budgets['1'] = { ...mandate.budgets['100'] }; }, rows: fixture => [{ event: 'broadcast-intent', hash: ethers.keccak256('0x1234'),
    mandateId: fixture.mandate.id, mandateDigest: fixture.plan.mandateDigest, chainId: 1,
    charges: { nativeSpendWei: '1000000', feeWei: '500000', valueWei: '500000', nativeDepositWei: '0', nativeLossWei: '1000000', tokens: [] } },
  { event: 'confirmed', hash: ethers.keccak256('0x1234') }] });
  assert.equal(separateChainBudget.objects.at(-1).status, 'confirmed');
  const tokenLimit = { address: recipient, spendRaw: '10', depositRaw: '10', lossRaw: '20', approvalRaw: '10' };
  const tokenWithin = await run('send', { mutateMandate: mandate => { mandate.budgets['100'].tokenLimits = [tokenLimit]; },
    mutatePlan: plan => { plan.exposure.tokens = [{ address: recipient, spendRaw: '5', depositRaw: '5', lossRaw: '6', approvalRaw: '1' }]; } });
  assert.equal(tokenWithin.objects.at(-1).status, 'confirmed');
  const tokenOutside = await run('send', { mutateMandate: mandate => { mandate.budgets['100'].tokenLimits = [tokenLimit]; },
    mutatePlan: plan => { plan.exposure.tokens = [{ address: recipient, spendRaw: '11', depositRaw: '5', lossRaw: '12', approvalRaw: '1' }]; } });
  assert.equal(tokenOutside.exitCode, 1); assert.equal(tokenOutside.broadcasts, 0); assert.equal(tokenOutside.credentialReads, 0);
  const changedMandate = await run('send', { changeMandateWhileSigning: true });
  assert.equal(changedMandate.exitCode, 1); assert.equal(changedMandate.broadcasts, 0); assert.ok(!changedMandate.files.has(lockFile));
  const intentRows = fixture => [{ event: 'broadcast-intent', hash: ethers.keccak256('0xdeadbeef'),
    chainId: fixture.plan.chainId, from: signer, nonce: 0, confirmations: 2 }];
  const reconciled = await run('reconcile', { rows: intentRows, reconcileLock: true });
  assert.equal(reconciled.objects[0].status, 'confirmed'); assert.ok(!reconciled.files.has(lockFile)); assert.equal(reconciled.credentialReads, 0);
  const stillLive = await run('reconcile', { rows: intentRows, reconcileLock: true, liveOwner: true });
  assert.equal(stillLive.objects[0].lockRetained, true); assert.ok(stillLive.files.has(lockFile));
  const noReceipt = await run('reconcile', { rows: intentRows, reconcileLock: true, missingReceipt: true });
  assert.equal(noReceipt.objects[0].status, 'unresolved'); assert.ok(noReceipt.files.has(lockFile)); assert.equal(noReceipt.broadcasts, 0);
  const unconfirmed = await run('reconcile', { rows: intentRows, reconcileLock: true, lowConfirmations: true });
  assert.equal(unconfirmed.objects[0].status, 'pending-confirmations'); assert.ok(unconfirmed.files.has(lockFile));
  const wrongReceipt = await run('reconcile', { rows: intentRows, reconcileLock: true, wrongReceiptSender: true });
  assert.equal(wrongReceipt.exitCode, 1); assert.ok(wrongReceipt.files.has(lockFile));
  console.log(`PASS: ${scenarioCount} isolated chain 1/100/10 read, proof, simulation, 1/100 broadcast ordering, caps, authorization, nonce, reuse, cumulative budgets and receipt reconciliation scenarios. No real credentials or transactions used.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

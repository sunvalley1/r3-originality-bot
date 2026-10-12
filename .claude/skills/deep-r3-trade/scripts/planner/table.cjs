// planner/table.cjs - the fixed scope of deep-r3-trade, embedded so it is hash-pinned with the planner.
//
// Every value is copied from the skill text: the 98 rows and the three bundle headers from steps/C-select.md
// ("The fixed 98", which is the authority), the contract addresses from steps/C-select.md, F-max-ev.md,
// G-mint-and-trade.md, I-setup.md and the seer-protocol and evm-onchain skills, and the condition ids from
// SKILL.md's "Last verified" block. A change to the table in C-select.md is a change to this file (the planner
// test compares the two). Plain data; this module reads no file, no network and no environment variable.
'use strict';

const ADDR = Object.freeze({
  sUSDS: '0xb5b2dc7fd34c249f4be7fb1fcea07950784229e0',
  USDS: '0x4F13a96EC5C4Cf34e442b46Bbd98a0791F20edC3',
  USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  WETH: '0x4200000000000000000000000000000000000006',
  PSM3: '0xe0F9978b907853F354d79188A3dEfbD41978af62',
  ROUTER: '0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD', // Seer Router (split / merge / redeem)
  CTF: '0x8bdC504dC3A05310059c1c67E0A2667309D27B93', // ConditionalTokens
  REALITY: '0x0eF940F7f053a2eF5D6578841072488aF0c7d89A', // Reality.eth
  SWAP: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // Uniswap SwapRouter02
  QUOTER: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // Uniswap QuoterV2
  FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984', // Uniswap V3 factory
  MC3: '0xcA11bde05977b3631167028862bE2a173976CA11', // Multicall3
  PARENT: '0x37ab5cbeee3a32289430e5d38b914ec7f580fd87',
  PARENT_INVALID: '0xe0d849F471037A9bE5dB2bDf21f9abaaBaD9F25c',
});

// SKILL.md "Last verified": the parent's and the three middles' condition ids.
const CONDITIONS = Object.freeze({
  parent: '0x709cd7099fc6a02d10cd7a438ede864ae5ed3d63cf4b3df607a3d4f8f5bc346a',
  A: '0xb3fce1ea05226dfd6e2acbeec24d780cc2b7fb534284d789e6f58c00266afd46',
  B: '0xaf03ed95731f2902fdf1c749881c6cbf6b70612c545941b1a39d0a756f65f0a5',
  C: '0x971f1cc8b76104f6cc9f9c5b518dcdd7c882d2ff87f1f29888b552fc3d693f03',
});

const CHAIN_ID = 10;
const CONTEST = 'round3';
const FEE_TIER = 100;
const BUNDLE_SPLIT = Object.freeze({ A: 33, B: 33, C: 32 });

// steps/C-select.md "The fixed 98", bundle by bundle, rows in table order.
const RAW = [
  {
    name: 'A', parentOutcome: 0, bundleToken: '0x8d883809dE718bAF9FCAd72133007B6115f77F6D', middle: '0xc217920a91f1b3d56276393aa5345f01a848ecf0', middleInvalid: '0x22DE5F831d7d61698dd56D7fD5B3d4a4B8710b83', nRepos: 33,
    rows: [ // [repo, slot, child market address, repo token]
      ['ethereum/py_ecc', 0, '0x5d6a571b0f663c33831e6f81dd3c3f554eca188b', '0xc9335b722174a667c6c7d69ee85412dc41332b4c'],
      ['blockscout/blockscout', 1, '0xe263e7febb2ccfe1ebb05f289cf858d3becec83f', '0xdc5d24ef28bcd21b75ec891efd56696e0ce7f6c8'],
      ['LFDT-web3j/web3j', 2, '0xf799b67f0b8da6ed75d6d31370346e2dd6be187d', '0x9657c41ff217dff4d12440c8f90fb35727b8cc58'],
      ['herumi/mcl', 3, '0xc7846582934c4c1d1156ddf44d988f6857b0f743', '0xae62d632ca2cf25c84cbf343c833f11aee44ff79'],
      ['paulmillr/noble-curves', 4, '0xf74142573cd11d76501dfd51d5512fc6b8ca7933', '0x9f2ab3d59aa30e63b8698538b5c0990d32d5f93d'],
      ['arkworks-rs/algebra', 5, '0xb52c7e58dc48250b6cb4fbe5ed251f617700bf06', '0x3da35d4535502f5e9f0d42ef81b8dd1b2f73ac64'],
      ['flashbots/rbuilder', 6, '0xb44e4ad21d40efb87a87c0692e28c71c90d08d20', '0x959b8e01b52b0c0db1f6bb09472fbd01cb7eb898'],
      ['protofire/solhint', 7, '0x808055e027cada3fb6d2b84104cd46b6685c048e', '0xcdd7945aa385dbdcbfa7341c7f51533581aacf1e'],
      ['l2beat/l2beat', 8, '0x0954b44c816f034c6c30a0b049f0ceb6bda6100a', '0xd989451a073eb66d3f67006d3180c2f6d7c3de26'],
      ['Consensys/gnark-crypto', 9, '0x9fc615e9a9e2066d3e8dda5c1c5280461489d808', '0xb383ca42f8dfd4877bcc59cc5504421d14bf436f'],
      ['Vectorized/solady', 10, '0x1e405c9bcf5038770efc4e5065cd216f93658b80', '0x8c4bc88cce543c173faac9aaf9137fe89f022568'],
      ['taikoxyz/taiko-mono', 11, '0x6a6a3326d701d464034d141bece8c21a06b7854b', '0xe7e63c87ded7510de737693575573a9ad00e96b6'],
      ['flashbots/mev-boost', 12, '0xc53217f3ca3371921076c4e7ea9457ea3b758317', '0x29d9ef12cd83fc988a22cb3c2985eb535e8ceb36'],
      ['flashbots/mev-boost-relay', 13, '0xfd9f5746c9451fedc03fa9d334d84099b61017ca', '0x131e612c62d1e9a81cb363dfab986e28833dda97'],
      ['ethereum/js-ethereum-cryptography', 14, '0x018a386a46949fbc8781b1254636b3a76e60a57c', '0x556eb58d13e2628507d13a3d54d45d7ba503023f'],
      ['libp2p/libp2p', 15, '0xde89236ae23777bdf655344858c44fa581c470a3', '0x571d94278a274abbb904011d31a3e34a42114a20'],
      ['supranational/blst', 16, '0x74a00a7a338f0fa8ce7afedb27279a30cf24df85', '0x736f833ca8d46912d00696c107be1e31ada850e1'],
      ['wighawag/hardhat-deploy', 17, '0xc8db7cdd4bc8006353dd09d87ecab65f84c620e5', '0xa9e1b0be4b73e99cac245eb0416667177f0f4031'],
      ['ethstaker/eth-docker', 18, '0x9525a58d53bc9d395ef56ec4c11e39370a88a304', '0xd81974ede39ce3d512a58f67af191c9e36cfae13'],
      ['DefiLlama/DefiLlama-Adapters', 19, '0xd71b2fe2ff2c91d5d822ce6399c646137723186a', '0x4f68190347793cc9e1f21bb0cebb0f9f8c1269d9'],
      ['DefiLlama/chainlist', 20, '0x4b8bda295e28375ed17abc8d1472e9cccadc93aa', '0x6f7b1d0411f5e3d1908fa09b1cec4e9968b03095'],
      ['Certora/CertoraProver', 21, '0x45dc37854a86f647cf45890f7167c0adc19814f2', '0x88c5f00c75d20d89b9deaee70aa5951c2b3a8e46'],
      ['Plonky3/Plonky3', 22, '0x8df828fcba7ec2b014742e202cf091807df939e6', '0x8671f584409b8672aff2c7eda4104fcd6e5b2649'],
      ['ChainSafe/bls', 23, '0xf8d574d0a7dc92deb6ae61adae9ad1219aac2c73', '0xafd9706a0ef6e4238b5dc01c9e76b5bc45bd8fdd'],
      ['intellij-solidity/intellij-solidity', 24, '0xd413f199fb40a5c85e96b3582dda718570ae7675', '0x35fddb246dd89f01c2f769b3b73dd4fc3765360c'],
      ['dappnode/DAppNode', 25, '0xdd8e32840a811d26aac9112f530490ee86d89bbc', '0x0822bc2d29ca68c316bdf8d91c622e5a42af215a'],
      ['wealdtech/ethdo', 26, '0x1773e3a7d522e80903e9914a88c815e126fb0f81', '0x5ed357484aff3957614381a8c506755b2f4a76c5'],
      ['lambdaclass/lambdaworks', 27, '0xd756f4a29de73f261f32185d0982c8e454db3356', '0xc52ac4cd416bc1777d6fb1ce0478fc8f571f8f9c'],
      ['smartcontracts/simple-optimism-node', 28, '0x04f4d33c6aa72320a822bc0fcb32e097a45ae4f9', '0x6e360b9643d3483737be154a0816a9b7e6cdd351'],
      ['skalenetwork/libBLS', 29, '0x5ba02d2373096140102b6d552e62f9d0f7c7c39d', '0x0fb41f0653c7c682748ba4adff1a5ffe0e1c6692'],
      ['shazow/whatsabi', 30, '0x5449093d1b651b090120a51acf68265bbcb56df3', '0x8223d38cd03a88a08f2d03d635e39ee971f665bc'],
      ['TrueBlocks/trueblocks-core', 31, '0x1b3140613dc1579d5486b8eee5ff8115ce7b93de', '0xf77035e68764552c03f9c9753b72ac7b930e3ea7'],
      ['EspressoSystems/jellyfish', 32, '0x72e12907d277199d7a44fde21d7dd981150b0f1a', '0xa26d64530e6666df346812fdd19c487f0e3bc7c5'],
    ],
  },
  {
    name: 'B', parentOutcome: 1, bundleToken: '0x9F26c46B5d70E5d9ce2b499F7F3d520f34aDd353', middle: '0xf0638b8999aaa0de3f5d02048a385a64e7a63aec', middleInvalid: '0x27CA6b333E5E0f7BA5635B72F8E03c40a84A68A3', nRepos: 33,
    rows: [ // [repo, slot, child market address, repo token]
      ['a16z/halmos', 0, '0x293a1858e689c117708e509770b283f281bbf6cb', '0x65b1380266291da3e6101c5a7f066fcbe1e74370'],
      ['succinctlabs/op-succinct', 1, '0x48eb0ebbb9284b0d8c51747da2fc4b9f342b401f', '0x38180d18d25429832e6a83675d9a7cb256980795'],
      ['succinctlabs/sp1', 2, '0xf713fcde2dd95050ffe68965ab17c1f3fadebc21', '0x20b0c27ab29cef1493f035c3edf107f1b34ac1de'],
      ['otterscan/otterscan', 3, '0x5457786b0f850f037496073905fd62de3572fa83', '0x63716ceabd3a1ced5a01edf18ea66cc46f7cfb84'],
      ['lambdaclass/ethrex', 4, '0x19eb4b247fe868df4ae6d94c118ca39b950a738d', '0x16e52dd5c973293da885a995d59f2ffee932b52a'],
      ['NethermindEth/juno', 5, '0x6aa9ba4a89cc1f5d854b898ed34f4370a3857585', '0x17e635fa17505fe52dee1e51223661d5b665fad6'],
      ['Commit-Boost/commit-boost-client', 6, '0x93d2239a2ae25e0ed759b9caf246c3c555b55a2f', '0x31f154fcb1ddcbb00b90721c94052dc7907fe7bb'],
      ['Cyfrin/aderyn', 7, '0x8717e0e2733acb24ac964667e2252bc118fb2249', '0x3ce18c72148fda70bb17443e6feab258483fc593'],
      ['0xMiden/miden-vm', 8, '0x6ea039fba3c1a54ed6c5ef04c394dd2a9c26c52a', '0x39dbc18c06ab8ee04828d37cf5e464edbc53e9aa'],
      ['holiman/goevmlab', 9, '0xdbdcdaf2aa3d75e1818029c26fef7fdd12dce893', '0x0e36e7eef8d0646c1590598e6b6f38167a9e3109'],
      ['edb-rs/edb', 10, '0x73918952494d08ed3eb5c2bf82eb056f51274639', '0x3f5b2e23bc1301b968bb50773d3639c3b20e100b'],
      ['evmts/tevm-monorepo', 11, '0x4a4feb5f866310c4b538abda903e53677b5956c9', '0x0819d02842ba743e55cdb3963a52c16a772ede9b'],
      ['succinctlabs/rsp', 12, '0xfc80e4c59c72ab78d73886cf98139a0e4726deee', '0x6c234f12e3455a9848c48f4f9a4dbedae715ea48'],
      ['aestus-relay/mev-boost-relay', 13, '0xd264f08e1871926d45f08ba8c19927ba909ed495', '0xd7232c484d5471dc25446eabf0b7dd5c6de3c6c1'],
      ['OffchainLabs/stylus-sdk-rs', 14, '0x86b3b071bd6c383e4544b18353cde9ca203158ce', '0xfb858c0532aee44defc243cc2ce627531603a444'],
      ['ethstaker/ethstaker-deposit-cli', 15, '0x36b1a703d790770ef14b875d3a0d2e0ded6234c1', '0x9ce41ddbae0a0a87b6806c88d99c37ea87b969dc'],
      ['dl-solarity/solidity-lib', 16, '0x4b62af2f270b59ec49230d3a06b63752964a4311', '0x368e7ea451a5aa750b0bbcacc0016942c56f93ad'],
      ['risc0/risc0-ethereum', 17, '0x1c3486fec53da0d19a4b0253b83748df31e10178', '0x4c50544e596f1c222aa7f7589ea3658f92dc726d'],
      ['powdr-labs/powdr', 18, '0x572f1f68c236460581ad720e1b262a604d92e703', '0x325532a7abad17fcdcdb5e3b810175ff8a48c675'],
      ['axiom-crypto/snark-verifier', 19, '0x52634d6c3fb85d5f4566550e0a85bed365524c39', '0xccf8ad49acd7a708ce362ac04777389de96fe986'],
      ['swiss-knife-xyz/swiss-knife', 20, '0x2109380e3dee45109d635c9968733c1f43568125', '0x90d3dcc0f981ec79f647b50d7bfe09af01eb855c'],
      ['a16z/helios', 21, '0x842cf887862213513895e1aa1714723009512932', '0xd73749038f49d285077cc5a98115c8bd804c22e8'],
      ['alloy-rs/alloy', 22, '0x107af2f9daacad63256adc9c54ddbd630b2b87d6', '0x9664e2fc602c98cb93b1c459fc9b72c68eba9a84'],
      ['apeworx/ape', 23, '0x34e4762227c29fb484c79cdc0a2a305fdd39ba56', '0x83145e3924d19c0a9a3a587887fb8599a5610c21'],
      ['chainsafe/lodestar', 24, '0x7c3b8fa85d532f7ed1fd8f32054b0497541db623', '0x91b585db7686823cf03e85c1d789793fd3888b0f'],
      ['consensys/teku', 25, '0xe1e506f60e6caaa6521b65231a293053b39494cd', '0x424fe875e8617a4c0f0357afcefb017faf197de6'],
      ['erigontech/erigon', 26, '0x87a54a3ad188dfea96aa128922351fdc12da80e3', '0x81f1d2106983e161fc8c987026933061ebd78a25'],
      ['eth-infinitism/account-abstraction', 27, '0xcb8ab4238ae037096e274486c4892d843e769dde', '0xd8110b587211d99d0af10a28e94379293ae64e6c'],
      ['ethereum-lists/chains', 28, '0xddd9d1a6ace5dca0432719b05691bb2cc7e0b9dd', '0x44d5c6d8b7cb997d420799e8a89ecb2f540abf08'],
      ['ethereum/consensus-specs', 29, '0x7cae39d3c40b0db913ba38f61f18173be8105852', '0x511cbb66babbe2235d1fdb13f13b0a923d240a93'],
      ['ethereum/eips', 30, '0x238910d606c68d7198a51377c079812be40f4d99', '0x5de6940bae90620ceeb70932ce5224bca8ab89c5'],
      ['ipsilon/evmone', 31, '0xd8825bf53db973dff16759f750c7cc86c9d45297', '0xcdc838866c609feb9afae8e1ad7037507a01f3a9'],
      ['ethereum/execution-apis', 32, '0x526f501d8a0a9426140d3c710262e11c3849a474', '0xa77b1b1a34e549b95436249da457ac152cb2da22'],
    ],
  },
  {
    name: 'C', parentOutcome: 2, bundleToken: '0xa6Ebc6002ACB875A31922c37d2A9d5bb319d2b06', middle: '0x99a941135226813037e15e34956fdd79761307d3', middleInvalid: '0xf91A162f24d2DeF43AD939e52fcF5CF9Fb8aaf6c', nRepos: 32,
    rows: [ // [repo, slot, child market address, repo token]
      ['argotorg/fe', 0, '0xb533d9b1becb3ee98820ee2342fbc9a062c296ca', '0x41a0a1f31daffb38780994c92c80e9af2a527336'],
      ['ethereum/go-ethereum', 1, '0xecbf7ba97acc47e030ab623fa78f983892254309', '0x44a4e9f87045c87b78e4c143db9adfff940780bb'],
      ['remix-project-org/remix-project', 2, '0x9de9aaa9c3beb5226a0acedfa3515c5a3c658b1d', '0x3ea620d590b5636666262a38d19fefe32bb6ee7e'],
      ['argotorg/solidity', 3, '0x38a9dc84c9f940262b548856c1869f992ee80ba4', '0x87ef78931586966064ce42f0137e65f9e5e95ef9'],
      ['argotorg/sourcify', 4, '0x5c4a21e1a101c3aff192d2d307ad9bbe3d761b1e', '0x2070db21df0906e65657ce9059bdc16b8b117c62'],
      ['ethereum/web3.py', 5, '0x9ab54e515c12e14048b009a366a4845570c5ee6d', '0xd6581faa139e8b120aa19f4cf867057ce9831439'],
      ['ethers-io/ethers.js', 6, '0x7fa95b23093b66d4b4fd0e89717b7e7883c888bc', '0x139a9bfca52ccfc41e9815bed51db5b9059e1f65'],
      ['foundry-rs/foundry', 7, '0xa1cc3bd62aea7b21547f327ed20e18d8b92d89d4', '0x6f9b72ec82fc63de2d7f7cba433994c8f6a96a90'],
      ['grandinetech/grandine', 8, '0xb2453e9a21cc82280fa95e6bbe6ca34e78b722d4', '0xce2008a64723f38aef1569d704f428471ed481ff'],
      ['hyperledger-web3j/web3j', 9, '0x15607f6d09dd27d174d6d76ebbcc708da5a56646', '0x80cb93cc7e7eb1e2dc42d298a9124f0bb73dab05'],
      ['hyperledger/besu', 10, '0x5a56ecb388369c2a92b51ca1e08c32f233baf178', '0x60828e159bd00aa44005b77e70cb6b670d4078cc'],
      ['nethereum/nethereum', 11, '0x49837e744bb14fab9b256785ab050352c3340aff', '0x588237ecd315c83889de66618dd53d0a44c376d0'],
      ['nethermindeth/nethermind', 12, '0x84e989e3dd24b2d8448d2a90e72eab1202083f59', '0x73a69a78d90b6e498b751913f455bd60233f741a'],
      ['nomicfoundation/hardhat', 13, '0xec73b19d493bb773eaed4df6b0c8f18842e77c26', '0x389d0b026e15fdcd5d8e263d2a7ddc33e32bc722'],
      ['openzeppelin/openzeppelin-contracts', 14, '0xde4c752ed72f51de6d57085728a564a08866e97c', '0x88d3d4265bf6535067cd05d77c026866a6598a21'],
      ['paradigmxyz/reth', 15, '0xd2652335a8576ff1e61c10aa531aee08d2533cde', '0x8fbd8162ba195cdc9e56186f1b7685522cba8da4'],
      ['OffchainLabs/prysm', 16, '0x1ac42dde2f605435771a0a4b6928b8c802388285', '0x211584a361b9a920945c02a52e3eb62981d57859'],
      ['safe-global/safe-smart-account', 17, '0xad30e4cc2f96e533a92cef4fcd9c57d4a4e5188c', '0x89c7abce9ae68f5584c4bb86b84cda15d01f9935'],
      ['scaffold-eth/scaffold-eth-2', 18, '0x09790fb4115e57367f47c82244cce088583e503f', '0x14f3d97396ca0c8caa8447d944c60e635eaa3e6b'],
      ['sigp/lighthouse', 19, '0x6a8c24d317ca7edcc0c996d41950e0cf2e622e6c', '0xba1df6263fbfd5babbf08ce673ef0437db26fb34'],
      ['status-im/nimbus-eth2', 20, '0xe48392583e40d8194c8019f4fa4c6bb60536c8b8', '0x92858d91e4c89d3e5f3d93b1898b60e2e5f3aba8'],
      ['vyperlang/titanoboa', 21, '0x7942645c35fa3a7f84ff1c731c81087f375c1eaa', '0x3edfa369dfaf28b23eb18b1b5368a838e020bb45'],
      ['vyperlang/vyper', 22, '0x845468b87b4821fae1d42f250c382b7a3a85bdb1', '0x4db187e536951f37e7b7ed346c879cf31e85229d'],
      ['wevm/viem', 23, '0xeb72792576d123fee15f8974784fd9026ab8d050', '0xd59ac75ecae4737a7b84996a4a74a6c088a361fe'],
      ['argotorg/hevm', 24, '0xdfb022190820d74babd62379fe53b45f0ac1cc67', '0xecb37fc746f8ed208403c033424ea21122da9cb2'],
      ['ethdebug/format', 25, '0x4b2b2d4e947c9e33e3ae18979562e752606127ac', '0x1bb4d5e1038ca721fa88ebd4191f7b458d43e7fd'],
      ['argotorg/act', 26, '0x0d91d33dc1bbe47469f5aef3dc113ed706ebabcb', '0x925957c3a67984c132a3fcb40e31fabb816aac77'],
      ['ethpandaops/ethereum-package', 27, '0x08dafca21f736aec39d0a45adf779cb8e437a61e', '0xbf9956578716fd906fdeba46664830a264aa8a13'],
      ['ethpandaops/ethereum-helm-charts', 28, '0xfd03f01a33eb653b75f59ab8e17c2f9ead376354', '0xa27009015686115acb57e2c81ed859cf9a5718cf'],
      ['ethpandaops/checkpointz', 29, '0x3ea9da5b674276d48d843b7e07daf95ac89ceffa', '0x99d2eed578f3ccc54a02b27d1b8261bda877efc6'],
      ['lambdaclass/lambda_ethereum_consensus', 30, '0x5285cd403845c358140c87f75488aec1aaf1a1f2', '0xae366d275fc93660068533ab9743853628d3bb5f'],
      ['erigontech/silkworm', 31, '0xbcb9981cdb1b7ed0b01505eb9c87aa4e25a9ccc0', '0x3dd51352377760f44d8b0d1e8af501c315dd4ed4'],
    ],
  },
];

// Build the flat table: { i, repo, slot, address, repo_token, bundle }. Checked once, at require time.
function build() {
  const bundles = []; const rows = [];
  for (const b of RAW) {
    bundles.push(Object.freeze({ name: b.name, idx: b.parentOutcome, bundleToken: b.bundleToken, middle: b.middle, middleInvalid: b.middleInvalid, nRepos: b.nRepos }));
    b.rows.forEach(([repo, slot, address, repoToken]) => rows.push(Object.freeze({ i: rows.length, repo, slot, address, repo_token: repoToken, bundle: b.name })));
  }
  const fail = (m) => { throw new Error('planner/table.cjs is inconsistent: ' + m); };
  if (rows.length !== 98) fail('row count ' + rows.length);
  for (const b of bundles) {
    const rs = rows.filter((r) => r.bundle === b.name);
    if (rs.length !== b.nRepos || rs.length !== BUNDLE_SPLIT[b.name]) fail(`bundle ${b.name} has ${rs.length} rows`);
    rs.forEach((r, k) => { if (r.slot !== k) fail(`slot gap in ${b.name} at ${k}`); });
  }
  const lowerAddr = /^0x[0-9a-f]{40}$/;
  for (const r of rows) if (!lowerAddr.test(r.address) || !lowerAddr.test(r.repo_token)) fail('address not lowercase hex at row ' + r.i);
  if (new Set(rows.map((r) => r.address)).size !== 98 || new Set(rows.map((r) => r.repo_token)).size !== 98) fail('duplicate address or repo token');
  if (new Set(rows.map((r) => r.repo)).size !== 98) fail('duplicate repo string');
  return { bundles: Object.freeze(bundles), rows: Object.freeze(rows) };
}
const T = build();
const lc = (s) => String(s).toLowerCase();
const bundleOf = (row) => T.bundles.find((b) => b.name === row.bundle);
const bundleIndex = (row) => T.bundles.findIndex((b) => b.name === row.bundle);
// The scope list of the parent's wrapped tokens, in order: [A, B, C, parent Invalid] (C step 2.5).
const PARENT_WRAPPED = Object.freeze([...T.bundles.map((b) => b.bundleToken), ADDR.PARENT_INVALID]);

module.exports = { ADDR, CONDITIONS, CHAIN_ID, CONTEST, FEE_TIER, BUNDLE_SPLIT, T, bundleOf, bundleIndex, PARENT_WRAPPED, lc };

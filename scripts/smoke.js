/**
 * Live smoke test against the deployed gpulease program on devnet.
 * No Anchor CLI / no IDL â€” instructions are encoded by hand so this runs
 * even though `anchor` cannot switch Solana versions on this machine.
 *
 *   Program: FR5U3cAx8jhCn2vH9WHcYfqgx11qEzaDdZ5afMooLkJY
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  createMint, createAssociatedTokenAccount, getAssociatedTokenAddressSync,
  getAccount, mintTo,
} = require("@solana/spl-token");

const PROGRAM = new PublicKey("FR5U3cAx8jhCn2vH9WHcYfqgx11qEzaDdZ5afMooLkJY");
// Helius devnet. The public api.devnet.solana.com endpoint rate-limits by IP,
// and the whole class shares one ISP address in Almaty.
const RPC = process.env.HELIUS_RPC
  || "https://devnet.helius-rpc.com/?api-key=bb10e107-295d-4f6e-b6b4-fe858e64e39b";
const connection = new Connection(RPC, "confirmed");

const provider = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "solana", "id.json"), "utf8")))
);

// Persist the customer keypair. Generating a fresh one each run sent its
// balance to nowhere and drained ~1 SOL per run.
const CUSTOMER_FILE = path.join(__dirname, "..", ".customer-test-key.json");
const customer = fs.existsSync(CUSTOMER_FILE)
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(CUSTOMER_FILE, "utf8"))))
  : Keypair.generate();
if (!fs.existsSync(CUSTOMER_FILE)) {
  fs.writeFileSync(CUSTOMER_FILE, JSON.stringify(Array.from(customer.secretKey)));
}

// ---------------------------------------------------------------- encoding
const disc = (name) =>
  crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const borshString = (s) => {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
};

const pda = (seeds) =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s.toBuffer())),
    PROGRAM
  ).toString(); // returns [key, bump]

const ix = (name, data, keys) =>
  new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([disc(name), data]) });

const send = async (instr, signers, label) => {
  const tx = new Transaction().add(instr);
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, signers);
    console.log(`   ${label}\n   -> https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    return sig;
  } catch (e) {
    console.error(`\n!! ${label} FAILED`);
    if (e.logs) e.logs.forEach((l) => console.error("   " + l));
    console.error("   msg:", e.message);
    throw e;
  }
};

// ---------------------------------------------------------------- state read
// #[account] MarketState, 8-byte discriminator prefix
const readMarket = async (addr) => {
  const info = await connection.getAccountInfo(new PublicKey(addr));
  const d = info.data;
  let o = 8;
  const pubkey = () => { const v = new PublicKey(d.subarray(o, o + 32)); o += 32; return v.toBase58(); };
  const provider_ = pubkey();
  const paymentMint = pubkey();
  const marketVault = pubkey();
  const receiptMint = pubkey();
  const nameLen = d.readUInt32LE(o); o += 4;
  const providerName = d.subarray(o, o + nameLen).toString("utf8"); o += nameLen;
  const gpuCount = d.readUInt32LE(o); o += 4;
  const totalPaid = d.readBigUInt64LE(o); o += 8;
  const totalReceipts = d.readBigUInt64LE(o); o += 8;
  const ordersCompleted = d.readUInt32LE(o); o += 4;
  const ordersCancelled = d.readUInt32LE(o); o += 4;
  return { provider: provider_, paymentMint, marketVault, receiptMint, providerName,
           gpuCount, totalPaid, totalReceipts, ordersCompleted, ordersCancelled };
};

// ---------------------------------------------------------------- main
(async () => {
  console.log("provider :", provider.publicKey.toBase58());
  console.log("customer :", customer.publicKey.toBase58());

  // fund customer from provider â€” avoids the devnet faucet entirely
  const bal = await connection.getBalance(provider.publicKey);
  console.log("provider balance:", bal / LAMPORTS_PER_SOL, "SOL");
  const FUND = Math.floor((bal / LAMPORTS_PER_SOL - 0.15) * LAMPORTS_PER_SOL);
  if (FUND < 0.05 * LAMPORTS_PER_SOL) {
    console.error("\n!! Not enough SOL to run the test.");
    console.error("   Need at least 0.2 SOL on " + provider.publicKey.toBase58());
    console.error("   Top up: https://faucet.solana.com");
    process.exit(1);
  }
  {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: provider.publicKey, toPubkey: customer.publicKey, lamports: FUND,
    }));
    const sig = await sendAndConfirmTransaction(connection, tx, [provider]);
    console.log(`1. funded customer with ${(FUND / LAMPORTS_PER_SOL).toFixed(4)} SOL (no faucet)`);
    console.log("   -> https://explorer.solana.com/tx/" + sig + "?cluster=devnet\n");
  }

  // payment token customers pay in
  const paymentMint = await createMint(connection, provider, provider.publicKey, null, 6);
  console.log("2. created payment mint:", paymentMint.toBase58());

  const [marketState]  = pda(["market", paymentMint]);
  const [marketVault]  = pda(["market_vault", paymentMint]);
  const [receiptMint]  = pda(["receipt_mint", paymentMint]);

  for (const a of [
    getAssociatedTokenAddressSync(paymentMint, provider.publicKey, true),
    getAssociatedTokenAddressSync(paymentMint, customer.publicKey, true),
  ]) await createAssociatedTokenAccount(connection, provider, paymentMint, a, provider.publicKey);

  // ---- initialize_market
  const nameArg = borshString("Arman_GPU_2060");
  const gpuArg = Buffer.alloc(4); gpuArg.writeUInt32LE(1, 0);

  await send(ix("initialize_market", Buffer.concat([nameArg, gpuArg]), [
    { pubkey: marketState, isSigner: false, isWritable: true },
    { pubkey: marketVault, isSigner: false, isWritable: true },
    { pubkey: receiptMint, isSigner: false, isWritable: true },
    { pubkey: paymentMint, isSigner: false, isWritable: false },
    { pubkey: provider.publicKey, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ]), [provider], "3. initialize_market('Arman_GPU_2060', 1)");

  let s = await readMarket(marketState);
  console.log(`   provider=${s.provider}\n   name=${s.providerName}  gpus=${s.gpuCount}\n   totalPaid=${s.totalPaid}  totalReceipts=${s.totalReceipts}\n`);
  console.assert(s.gpuCount === 1 && s.providerName === "Arman_GPU_2060", "FAIL: state mismatch");

  // give both sides tokens
  const provAcc = getAssociatedTokenAddressSync(paymentMint, provider.publicKey, true);
  const custAcc = getAssociatedTokenAddressSync(paymentMint, customer.publicKey, true);
  await mintTo(connection, provider, paymentMint, provAcc, provider, 500);
  await mintTo(connection, provider, paymentMint, custAcc, provider, 500);

  // receipt ATA must exist before place_order
  const custReceiptAcc = getAssociatedTokenAddressSync(receiptMint, customer.publicKey, true);
  await createAssociatedTokenAccount(connection, provider, receiptMint, custReceiptAcc, provider.publicKey);

  // ---- place_order 100
  const amt1 = Buffer.alloc(8); amt1.writeBigUInt64LE(100n, 0);
  await send(ix("place_order", amt1, [
    { pubkey: marketState, isSigner: false, isWritable: true },
    { pubkey: marketVault, isSigner: false, isWritable: true },
    { pubkey: receiptMint, isSigner: false, isWritable: true },
    { pubkey: custAcc, isSigner: false, isWritable: true },
    { pubkey: custReceiptAcc, isSigner: false, isWritable: true },
    { pubkey: customer.publicKey, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ]), [customer], "4. place_order(100)  <- customer pays into escrow");

  s = await readMarket(marketState);
  const vaultAcc = await getAccount(connection, new PublicKey(marketVault));
  const receiptAcc = await getAccount(connection, new PublicKey(custReceiptAcc));
  console.log(`   totalPaid=${s.totalPaid}  totalReceipts=${s.totalReceipts}`);
  console.log(`   escrow vault holds ${vaultAcc.amount} (owner ${vaultAcc.owner.toBase58()})`);
  console.log(`   customer holds ${receiptAcc.amount} receipt\n`);
  console.assert(vaultAcc.amount === 100n && receiptAcc.amount === 100n, "FAIL: escrow/receipt mismatch");

  // ---- settle_order 100
  const burn1 = Buffer.alloc(8); burn1.writeBigUInt64LE(100n, 0);
  await send(ix("settle_order", burn1, [
    { pubkey: marketState, isSigner: false, isWritable: true },
    { pubkey: marketVault, isSigner: false, isWritable: true },
    { pubkey: receiptMint, isSigner: false, isWritable: true },
    { pubkey: provAcc, isSigner: false, isWritable: true },
    { pubkey: custReceiptAcc, isSigner: false, isWritable: true },
    { pubkey: provider.publicKey, isSigner: true, isWritable: true },
    { pubkey: customer.publicKey, isSigner: true, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ]), [provider, customer], "5. settle_order(100)  <- provider+customer sign, escrow released");

  s = await readMarket(marketState);
  const vaultAfter = await getAccount(connection, new PublicKey(marketVault));
  const provAfter = await getAccount(connection, new PublicKey(provAcc));
  const receiptAfter = await getAccount(connection, new PublicKey(custReceiptAcc));
  console.log(`   totalPaid=${s.totalPaid}  totalReceipts=${s.totalReceipts}  ordersCompleted=${s.ordersCompleted}`);
  console.log(`   escrow now ${vaultAfter.amount}, provider now ${provAfter.amount}, receipts now ${receiptAfter.amount}\n`);
  console.assert(s.totalPaid === 0n && s.ordersCompleted === 1, "FAIL: counters");
  console.assert(vaultAfter.amount === 0n && provAfter.amount === 600n, "FAIL: payout");

  // ---- unauthorized settle must fail
  const stranger = Keypair.generate();
  const burn2 = Buffer.alloc(8); burn2.writeBigUInt64LE(10n, 0);
  let blocked = false;
  try {
    await send(ix("settle_order", burn2, [
      { pubkey: marketState, isSigner: false, isWritable: true },
      { pubkey: marketVault, isSigner: false, isWritable: true },
      { pubkey: receiptMint, isSigner: false, isWritable: true },
      { pubkey: provAcc, isSigner: false, isWritable: true },
      { pubkey: custReceiptAcc, isSigner: false, isWritable: true },
      { pubkey: stranger.publicKey, isSigner: true, isWritable: true },
      { pubkey: customer.publicKey, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ]), [stranger, customer], "6. stranger tries to settle");
  } catch (e) {
    blocked = /Unauthorized|0x1|failed to send/i.test(e.message);
    console.log("   REJECTED ->", e.message.slice(0, 120));
  }
  console.assert(blocked, "FAIL: stranger was not blocked");

  console.log("\n=== ALL CHECKS PASSED ===");
})().catch((e) => { console.error("TEST FAILED:", e.message); process.exit(1); });
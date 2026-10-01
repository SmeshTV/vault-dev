const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, createMint, createAssociatedTokenAccount, getAssociatedTokenAddressSync } = require("@solana/spl-token");

const PROGRAM = new PublicKey("FR5U3cAx8jhCn2vH9WHcYfqgx11qEzaDdZ5afMooLkJY");
const RPC = process.env.HELIUS_RPC || "https://devnet.helius-rpc.com/?api-key=bb10e107-295d-4f6e-b6b4-fe858e64e39b";
const connection = new Connection(RPC, "confirmed");
const provider = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "solana", "id.json"), "utf8"))));

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const bs = (s) => { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(b.length, 0); return Buffer.concat([l, b]); };

(async () => {
  console.log("provider:", provider.publicKey.toBase58());
  console.log("balance:", (await connection.getBalance(provider.publicKey)) / 1e9, "SOL");

  const paymentMint = await createMint(connection, provider, provider.publicKey, null, 6);
  console.log("mint:", paymentMint.toBase58());

  const pda = (seeds) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s.toBuffer())), PROGRAM)[0];
  const marketState = pda(["market", paymentMint]);
  const marketVault = pda(["market_vault", paymentMint]);
  const receiptMint = pda(["receipt_mint", paymentMint]);
  console.log("PDAs:", { marketState: marketState.toBase58(), marketVault: marketVault.toBase58(), receiptMint: receiptMint.toBase58() });

  const g = Buffer.alloc(4); g.writeUInt32LE(1, 0);
  const data = Buffer.concat([disc("initialize_market"), bs("Arman_GPU_2060"), g]);

  const ix = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: marketState, isSigner: false, isWritable: true },
      { pubkey: marketVault, isSigner: false, isWritable: true },
      { pubkey: receiptMint, isSigner: false, isWritable: true },
      { pubkey: paymentMint, isSigner: false, isWritable: false },
      { pubkey: provider.publicKey, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = provider.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  const sim = await connection.simulateTransaction(tx);
  console.log("\nSIM err:", sim.value.err);
  console.log("logs tail:", (sim.value.logs || []).slice(-3).join(" | "));

  console.log("\n--- sending for real ---");
  try {
    const { sendAndConfirmTransaction } = require("@solana/web3.js");
    const sig = await sendAndConfirmTransaction(connection, tx, [provider]);
    console.log("SENT:", sig);
    console.log("https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
  } catch (e) {
    console.error("SEND FAILED");
    console.error("  name:", e.name);
    console.error("  message:", JSON.stringify(e.message));
    console.error("  code:", e.code);
    console.error("  own props:", Object.keys(e));
    for (const k of Object.keys(e)) {
      if (k === "logs") continue;
      console.error("   ", k, "=", JSON.stringify(e[k]));
    }
    if (e.logs) (e.logs || []).forEach((l) => console.error("   log:", l));
  }
})().catch((e) => {
  console.error("EXC:", e.name, "|", e.message, "|", e.stack ? e.stack.split("\n")[0] : "");
  if (e.err) console.error("err field:", JSON.stringify(e.err));
});
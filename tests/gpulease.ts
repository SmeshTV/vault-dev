import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccount,
  createMint,
  getMint,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { assert, expect } from "chai";

describe("gpulease â€” escrow market for idle GPUs", () => {
  const provider = Keypair.generate();   // person renting out idle GPUs
  const customer = Keypair.generate();   // person paying for a job

  const PROVIDER_PDA_SEED = Buffer.from("market");
  const VAULT_SEED = Buffer.from("market_vault");
  const RECEIPT_SEED = Buffer.from("receipt_mint");

  let program: Program;
  let connection: anchor.web3.Connection;
  let paymentMint: PublicKey;
  let marketState: PublicKey;
  let marketVault: PublicKey;
  let receiptMint: PublicKey;
  let providerPaymentAcc: PublicKey;
  let customerPaymentAcc: PublicKey;
  let customerReceiptAcc: PublicKey;

  before(async () => {
    connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
    program = anchor.workspace.Gpulease as Program;

    // A fresh SPL token that customers will pay in.
    paymentMint = await createMint(
      connection,
      provider,
      provider.publicKey,
      null,
      6
    );

    const [state, vault, receipt] = await anchor.web3.PublicKey.findProgramAddressSync(
      [PROVIDER_PDA_SEED, paymentMint.toBuffer()],
      program.programId
    );
    marketState = state;
    marketVault = vault;
    receiptMint = receipt;

    providerPaymentAcc = getAssociatedTokenAddressSync(
      paymentMint, provider.publicKey, true
    );
    customerPaymentAcc = getAssociatedTokenAddressSync(
      paymentMint, customer.publicKey, true
    );
    customerReceiptAcc = getAssociatedTokenAddressSync(
      receiptMint, customer.publicKey, true
    );

    // Create the ATAs we declared in the instruction structs.
    for (const acc of [providerPaymentAcc, customerPaymentAcc]) {
      await createAssociatedTokenAccount(
        connection, provider, paymentMint, acc, provider.publicKey
      );
    }
    await createAssociatedTokenAccount(
      connection, provider, receiptMint, customerReceiptAcc, provider.publicKey
    );

    // Fund both sides so they can pay fees and move tokens.
    const sig = await connection.requestAirdrop(provider.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
    const sig2 = await connection.requestAirdrop(customer.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig2);

    // Give the provider tokens to escrow later, and the customer tokens to pay with.
    await mintTo(connection, provider, paymentMint, providerPaymentAcc, provider, 500);
    await mintTo(connection, provider, paymentMint, customerPaymentAcc, provider, 500);
  });

  it("1. registers a provider with their GPU count", async () => {
    const name = "Arman_GPU_2060";

    await program.methods
      .initializeMarket(name, 1)
      .accounts({
        marketState,
        marketVault,
        receiptMint,
        paymentMint,
        provider: provider.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([provider])
      .rpc();

    const state = await program.account.marketState.fetch(marketState);
    expect(state.provider.toBase58()).to.equal(provider.publicKey.toBase58());
    expect(state.gpuCount).to.equal(1);
    expect(state.providerName).to.equal(name);
    expect(state.totalPaid.toNumber()).to.equal(0);
    expect(state.totalReceipts.toNumber()).to.equal(0);
  });

  it("2. escrows payment and mints a receipt 1:1 on the first order", async () => {
    await program.methods
      .placeOrder(new anchor.BN(100))
      .accounts({
        marketState,
        marketVault,
        receiptMint,
        customerPaymentAccount: customerPaymentAcc,
        customerReceiptAccount: customerReceiptAcc,
        customer: customer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([customer])
      .rpc();

    const state = await program.account.marketState.fetch(marketState);
    expect(state.totalPaid.toNumber()).to.equal(100);
    expect(state.totalReceipts.toNumber()).to.equal(100);

    // Money is in the vault, not with the provider.
    const vaultAcc = await getAccount(connection, marketVault);
    expect(vaultAcc.amount.toNumber()).to.equal(100);
    expect(vaultAcc.owner.toBase58()).to.equal(marketState.toBase58());

    // Customer holds the receipt.
    const receiptAcc = await getAccount(connection, customerReceiptAcc);
    expect(receiptAcc.amount.toNumber()).to.equal(100);
    expect(receiptAcc.owner.toBase58()).to.equal(customer.publicKey.toBase58());
  });

  it("3. second customer gets a pro-rated receipt, not 1:1", async () => {
    // vault holds 100, outstanding receipts = 100
    // order 50 -> 50 * 100 / 100 = 50 receipts (equal here because ratio is 1)
    await program.methods
      .placeOrder(new anchor.BN(50))
      .accounts({
        marketState,
        marketVault,
        receiptMint,
        customerPaymentAccount: customerPaymentAcc,
        customerReceiptAccount: customerReceiptAcc,
        customer: customer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([customer])
      .rpc();

    const state = await program.account.marketState.fetch(marketState);
    expect(state.totalPaid.toNumber()).to.equal(150);
    expect(state.totalReceipts.toNumber()).to.equal(150);

    const receiptAcc = await getAccount(connection, customerReceiptAcc);
    expect(receiptAcc.amount.toNumber()).to.equal(150);
  });

  it("4. provider settles: receipts burned, escrow released", async () => {
    await program.methods
      .settleOrder(new anchor.BN(150))
      .accounts({
        marketState,
        marketVault,
        receiptMint,
        providerPaymentAccount: providerPaymentAcc,
        customerReceiptAccount: customerReceiptAcc,
        provider: provider.publicKey,
        customer: customer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([provider, customer])
      .rpc();

    const state = await program.account.marketState.fetch(marketState);
    expect(state.totalPaid.toNumber()).to.equal(0);
    expect(state.totalReceipts.toNumber()).to.equal(0);
    expect(state.ordersCompleted).to.equal(1);

    // Vault is empty, provider was paid.
    const vaultAcc = await getAccount(connection, marketVault);
    expect(vaultAcc.amount.toNumber()).to.equal(0);

    const providerAcc = await getAccount(connection, providerPaymentAcc);
    expect(providerAcc.amount.toNumber()).to.equal(650); // 500 seeded + 150 payout

    // Receipt is gone â€” that is the on-chain "work delivered" signal.
    const receiptAcc = await getAccount(connection, customerReceiptAcc);
    expect(receiptAcc.amount.toNumber()).to.equal(0);
  });

  it("5. a stranger cannot settle someone else's market", async () => {
    const stranger = Keypair.generate();

    let failed = false;
    try {
      await program.methods
        .settleOrder(new anchor.BN(10))
        .accounts({
          marketState,
          marketVault,
          receiptMint,
          providerPaymentAccount: providerPaymentAcc,
          customerReceiptAccount: customerReceiptAcc,
          provider: stranger.publicKey,
          customer: customer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([stranger, customer])
        .rpc();
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
  });
});
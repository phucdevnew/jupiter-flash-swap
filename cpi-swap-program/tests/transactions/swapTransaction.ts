import { QuoteResponse, SwapInstructionsResponse } from "@jup-ag/api";
import {
  AccountMeta,
  ComputeBudgetProgram,
  MessageV0,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { init } from "../config";
import {
  CPI_SWAP_PROGRAM_ID,
  JUPITER_PROGRAM_ID,
  SOL_MINT,
  USDC_MINT,
} from "../const";
import { getAddressLookupTableAccounts } from "../utils/getAddressLookupTableAccounts";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

export async function swap() {
  const { wallet, provider, program } = await init();

  const quote = await getQuote();
  const quoteReverse = await getQuoteReverse(quote.outAmount);

  const [vaultAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    new PublicKey(CPI_SWAP_PROGRAM_ID)
  );

  const swapIxResponse = await getSwapResponse(vaultAddress, quote);
  const swapReverseIxResponse = await getSwapResponse(
    vaultAddress,
    quoteReverse
  );

  const addressLookupTableAccounts = await getAddressLookupTableAccounts(
    provider.connection,
    swapIxResponse.addressLookupTableAddresses
  );

  const addressLookupTableAccountsReverse = await getAddressLookupTableAccounts(
    provider.connection,
    swapReverseIxResponse.addressLookupTableAddresses
  );

  const solAta = await getAssociatedTokenAddress(
    new PublicKey(SOL_MINT),
    vaultAddress,
    true
  );
  const usdcAta = await getAssociatedTokenAddress(
    new PublicKey(USDC_MINT),
    vaultAddress,
    true
  );

  const createSolAtaInIx = createAssociatedTokenAccountIdempotentInstruction(
    wallet.publicKey,
    solAta,
    vaultAddress,
    new PublicKey(SOL_MINT)
  );
  const createUsdcAtaOutIx = createAssociatedTokenAccountIdempotentInstruction(
    wallet.publicKey,
    usdcAta,
    vaultAddress,
    new PublicKey(USDC_MINT)
  );

  /// Set CU to max for one transaction
  const simulateCuIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
  });
  /// Jupiter Swap requires priority fees to ensure transactions are processed quickly and successfully, especially during periods of high network congestion.
  const cupIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 200_000,
  });

  const remainingAccounts: AccountMeta[] =
    swapIxResponse.swapInstruction.accounts.map((account) => ({
      ...account,
      isSigner: false,
      pubkey: new PublicKey(account.pubkey),
    }));
  const remainingAccountsReverse: AccountMeta[] =
    swapReverseIxResponse.swapInstruction.accounts.map((account) => ({
      ...account,
      isSigner: false,
      pubkey: new PublicKey(account.pubkey),
    }));

  const swapInstruction = await program.methods
    .swap(Buffer.from(swapIxResponse.swapInstruction.data, "base64"))
    .accountsPartial({
      inputMint: new PublicKey(SOL_MINT),
      inputMintProgram: TOKEN_PROGRAM_ID,
      outputMint: new PublicKey(USDC_MINT),
      outputMintProgram: TOKEN_PROGRAM_ID,
      vault: vaultAddress,
      vaultInputTokenAccount: solAta,
      vaultOutputTokenAccount: usdcAta,
      jupiterProgram: new PublicKey(JUPITER_PROGRAM_ID),
    })
    .remainingAccounts(remainingAccounts)
    .instruction();

  const swapReverseInstruction = await program.methods
    .swap(Buffer.from(swapReverseIxResponse.swapInstruction.data, "base64"))
    .accountsPartial({
      inputMint: new PublicKey(USDC_MINT),
      inputMintProgram: TOKEN_PROGRAM_ID,
      outputMint: new PublicKey(SOL_MINT),
      outputMintProgram: TOKEN_PROGRAM_ID,
      vault: vaultAddress,
      vaultInputTokenAccount: usdcAta,
      vaultOutputTokenAccount: solAta,
      jupiterProgram: new PublicKey(JUPITER_PROGRAM_ID),
    })
    .remainingAccounts(remainingAccountsReverse)
    .instruction();

  const lastesttBlockhash = await provider.connection.getLatestBlockhash();

  const simulateMessage = MessageV0.compile({
    payerKey: wallet.publicKey,
    instructions: [
      simulateCuIx,
      cupIx,
      createSolAtaInIx,
      createUsdcAtaOutIx,
      swapInstruction,
      swapReverseInstruction,
    ],
    addressLookupTableAccounts: [
      ...addressLookupTableAccounts,
      ...addressLookupTableAccountsReverse,
    ],
    recentBlockhash: lastesttBlockhash.blockhash,
  });

  const transaction = new VersionedTransaction(simulateMessage);
  transaction.sign([wallet]);

  // const result = await provider.connection.simulateTransaction(transaction, {
  //   sigVerify: true,
  // });

  const txId = await provider.connection.sendTransaction(transaction, {
    maxRetries: 5,
  });
  console.log("🚀 ~ swap ~ txId:", txId);
  const result = await provider.connection.confirmTransaction({
    signature: txId,
    blockhash: lastesttBlockhash.blockhash,
    lastValidBlockHeight: lastesttBlockhash.lastValidBlockHeight,
  });
  console.log("🚀 ~ swap ~ result:", result);

  // const signature = await provider.connection.sendTransaction(transaction);
  // const result = await provider.connection.confirmTransaction(
  //   signature,
  //   "confirmed"
  // );
}

async function getQuote() {
  const inputMint = SOL_MINT;
  const outputMint = USDC_MINT;
  const amount = 100;
  const slippageBps = 50;

  // get quote
  try {
    const quoteResponse = (await (
      await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
      )
    ).json()) as QuoteResponse;

    return quoteResponse;
  } catch (error) {
    throw error;
  }
}

async function getQuoteReverse(inputAmount: string) {
  const inputMint = USDC_MINT;
  const outputMint = SOL_MINT;
  const amount = inputAmount;
  const slippageBps = 50;

  // get quote
  try {
    const quoteResponse = (await (
      await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
      )
    ).json()) as QuoteResponse;

    return quoteResponse;
  } catch (error) {
    throw error;
  }
}

async function getSwapResponse(user: PublicKey, quote: QuoteResponse) {
  // Get serialized transaction
  try {
    const swapInxResponse = (await (
      await fetch(`https://api.jup.ag/swap/v1/swap-instructions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          userPublicKey: user.toBase58(),
          quoteResponse: quote,
          wrapAndUnwrapSol: false,
          useSharedAccounts: true,
          dynamicComputeUnitLimit: true,
        }),
      })
    ).json()) as SwapInstructionsResponse;

    return swapInxResponse;
  } catch (error) {
    console.log("🚀 ~ getSwapResponse ~ error:", error);
  }
}

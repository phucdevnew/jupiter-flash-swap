import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { transactionSenderAndConfirmationWaiter } from "./utils/transactionSender";
import { getSignature } from "./utils/getSignature";
import {
  createJupiterApiClient,
  QuoteGetRequest,
  QuoteResponse,
} from "@jup-ag/api";
import { Program, Wallet } from "@coral-xyz/anchor";
import { CpiSwapProgram } from "../target/types/cpi_swap_program";

// If you have problem landing transactions, read this too: https://station.jup.ag/docs/apis/landing-transactions

// Make sure that you are using your own RPC endpoint. This RPC doesn't work.
// Helius and Triton have staked SOL and they can usually land transactions better.
const connection = new Connection(
  "https://api.mainnet-beta.solana.com" // We only support mainnet.
);

async function getQuote(inputMint) {
  const params: QuoteGetRequest = {
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    amount: 10, // 10 Lamports
    slippageBps: 50, // 0.5%
    dynamicSlippage: true,
  };

  // get quote
  const quote = await jupiterQuoteApi.quoteGet(params);

  if (!quote) {
    throw new Error("unable to quote");
  }
  return quote;
}

async function getSwapResponse(wallet: Wallet, quote: QuoteResponse) {
  // Get serialized transaction
  const swapResponse = await jupiterQuoteApi.swapInstructionsPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      dynamicComputeUnitLimit: true,
      dynamicSlippage: {
        minBps: 50,
        maxBps: 1000,
      },
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: 10,
          priorityLevel: "veryHigh", // If you want to land transaction fast, set this to use `veryHigh`. You will pay on average higher priority fee.
        },
      },
      correctLastValidBlockHeight: true,
    },
  });
  return swapResponse;
}

export async function flowQuoteAndSwap() {
  const program = anchor.workspace.CpiSwapProgram as Program<CpiSwapProgram>;

  const wallet = new Wallet(
    Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY || ""))
  );
  console.log("Wallet:", wallet.publicKey.toBase58());

  const quote = await getQuote();
  console.dir(quote, { depth: null });
  const swapIxResponse = await getSwapResponse(wallet, quote);
  console.dir(swapIxResponse, { depth: null });

  // let minRent = await connection.getMinimumBalanceForRentExemption(0);
  // let blockhash = await connection
  //   .getLatestBlockhash()
  //   .then((res) => res.blockhash);

  // const instructions = new TransactionInstruction({
  //   keys: [],
  //   programId: program.programId,
  //   data: Buffer.from([]),
  // });

  // const messageV0 = new TransactionMessage({
  //   payerKey: payer.publicKey,
  //   recentBlockhash: blockhash,
  //   instructions,
  // }).compileToV0Message();

  // swapTransaction.add(swapIxResponse);

  // Serialize the transaction
  const swapTransactionBuf = Buffer.from(
    swapResponse.swapTransaction,
    "base64"
  );

  // const tx = await program.methods.swap([]).rpc();

  var transaction = VersionedTransaction.deserialize(swapTransactionBuf);

  // Sign the transaction
  transaction.sign([wallet.payer]);
  const signature = getSignature(transaction);

  // We first simulate whether the transaction would be successful
  const { value: simulatedTransactionResponse } =
    await connection.simulateTransaction(transaction, {
      replaceRecentBlockhash: true,
      commitment: "processed",
    });
  const { err, logs } = simulatedTransactionResponse;

  if (err) {
    // Simulation error, we can check the logs for more details
    // If you are getting an invalid account error, make sure that you have the input mint account to actually swap from.
    console.error("Simulation Error:");
    console.error({ err, logs });
    return;
  }

  const serializedTransaction = Buffer.from(transaction.serialize());
  // const blockhash = transaction.message.recentBlockhash;

  const transactionResponse = await transactionSenderAndConfirmationWaiter({
    connection,
    serializedTransaction,
    blockhashWithExpiryBlockHeight: {
      blockhash,
      lastValidBlockHeight: swapResponse.lastValidBlockHeight,
    },
  });

  // If we are not getting a response back, the transaction has not confirmed.
  if (!transactionResponse) {
    console.error("Transaction not confirmed");
    return;
  }

  if (transactionResponse.meta?.err) {
    console.error(transactionResponse.meta?.err);
  }

  console.log(`https://solscan.io/tx/${signature}`);
}

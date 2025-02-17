import { simulateTransaction } from "@coral-xyz/anchor/dist/cjs/utils/rpc";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

export async function runSimulateTransaction(
  connection: Connection,
  signers: Array<Keypair>,
  feePayer: PublicKey,
  txs: Array<Transaction>
) {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  const transaction = new Transaction({
    blockhash,
    lastValidBlockHeight,
    feePayer,
  }).add(...txs);

  let simulateResp = await simulateTransaction(
    connection,
    transaction,
    signers
  );
  if (simulateResp.value.err) {
    console.error(">>> Simulate transaction failed:", simulateResp.value.err);
    console.log(`Logs ${simulateResp.value.logs}`);
    throw simulateResp.value.err;
  }

  console.log(">>> Simulated transaction successfully");
}

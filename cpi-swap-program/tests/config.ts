import { Connection } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CpiSwapProgram } from "../target/types/cpi_swap_program";
import idl from "../target/idl/cpi_swap_program.json";
import { createJupiterApiClient } from "@jup-ag/api";
import { getCurrentWallet } from "./utils/getCurrentWallet";
import { CLUSTER_URL } from "./const";

const connection = new Connection(CLUSTER_URL, "confirmed");

export const jupiterQuoteApi = createJupiterApiClient({
  basePath: "https://api.jup.ag/swap/v1",
});

export interface TestProvider {
  provider: anchor.AnchorProvider;
  program: anchor.Program<CpiSwapProgram>;
  wallet: anchor.web3.Keypair;
}

export const init = async (): Promise<TestProvider> => {
  const walletKeyPair = await getCurrentWallet();
  const customWallet = new anchor.Wallet(walletKeyPair);
  const customProvider = new anchor.AnchorProvider(connection, customWallet, {
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(customProvider);

  const program = new Program(idl as CpiSwapProgram, customProvider);

  console.log(`connect to rpc ${connection.rpcEndpoint} in ${CLUSTER_URL}`);

  return { provider: customProvider, program, wallet: walletKeyPair };
};

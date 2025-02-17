import { Keypair } from "@solana/web3.js";
import { readFile } from "fs/promises";
import path from "path";

export const getCurrentWallet = async (filepath?: string) => {
  if (!filepath) {
    // Default value from Solana CLI
    filepath = "~/.config/solana/id.json";
  }
  if (filepath[0] === "~") {
    const home = process.env.HOME || null;
    if (home) {
      filepath = path.join(home, filepath.slice(1));
    }
  }

  const fileContents = (await readFile(filepath)).toString();
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fileContents)));
};

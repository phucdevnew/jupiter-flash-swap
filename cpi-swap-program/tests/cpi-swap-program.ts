import { swap } from "./transactions/swapTransaction";

describe("cpi-swap-program", () => {
  it("Is initialized!", async () => {
    // Add your test here.
    // const tx = await program.methods.swap().rpc();
    // console.log("Your transaction signature", tx);
    await swap();
  });
});

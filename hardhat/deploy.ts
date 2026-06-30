import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import hre from "hardhat";

const ritual = defineChain({
  id: 1979,
  name: "Ritual",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.ritualfoundation.org"] },
  },
});

async function main() {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
  if (!privateKey) throw new Error("DEPLOYER_PRIVATE_KEY not set");

  const account = privateKeyToAccount(privateKey);
  console.log("Deploying from:", account.address);

  const publicClient = createPublicClient({
    chain: ritual,
    transport: http(),
  });

  const walletClient = createWalletClient({
    account,
    chain: ritual,
    transport: http(),
  });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log("Balance:", balance.toString(), "wei");

  const artifact = await hre.artifacts.readArtifact("AIJudge");

  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
  });

  console.log("Ì≥ù Transaction hash:", hash);
  console.log("‚è≥ Waiting for confirmation...");

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("‚úÖ AIJudge deployed to:", receipt.contractAddress);
}

main().catch(console.error);

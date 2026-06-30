import { createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import hre from "hardhat";

const ritual = defineChain({
  id: 1979,
  name: "Ritual",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.ritualfoundation.org"] } },
});

async function main() {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: ritual, transport: http() });
  const walletClient = createWalletClient({ account, chain: ritual, transport: http() });

  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
  console.log("Current nonce:", nonce);
  console.log("Deploying from:", account.address);

  const artifact = await hre.artifacts.readArtifact("AIJudge");
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
    nonce,
  });

  console.log("📝 TX hash:", hash);
  console.log("⏳ Waiting for confirmation...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("✅ Deployed to:", receipt.contractAddress);
}
main().catch(console.error);
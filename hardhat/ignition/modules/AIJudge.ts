import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
const AIJudgeModule = buildModule("AIJudgeModule", (m) => {
  const aiJudge = m.contract("AIJudge");
  return { aiJudge };
});

export default AIJudgeModule;
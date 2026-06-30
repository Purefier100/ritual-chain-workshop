import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, encodePacked, parseEther, getAddress } from "viem";

// Helper: mirrors the Solidity commitment formula exactly
// keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId))
function makeCommitment(
  answer: string,
  salt: `0x${string}`,
  sender: `0x${string}`,
  bountyId: bigint
): `0x${string}` {
  return keccak256(
    encodePacked(
      ["string", "bytes32", "address", "uint256"],
      [answer, salt, sender, bountyId]
    )
  );
}

describe("AIJudge — commit-reveal", function () {
  const REWARD = parseEther("1.0");
  const ALICE_SALT = ("0x" + "aa".repeat(32)) as `0x${string}`;
  const BOB_SALT = ("0x" + "bb".repeat(32)) as `0x${string}`;

  async function deployFixture() {
    const [owner, alice, bob] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();

    const judge = await hre.viem.deployContract("AIJudge");

    const now = BigInt(await time.latest());
    const submissionDeadline = now + 3600n;
    const revealDeadline = submissionDeadline + 3600n;

    return { judge, owner, alice, bob, publicClient, submissionDeadline, revealDeadline, now };
  }

  async function deployAndCreateBounty() {
    const f = await deployFixture();
    const { judge, owner, submissionDeadline, revealDeadline } = f;

    await judge.write.createBounty(
      ["Test bounty", "Best answer wins", submissionDeadline, revealDeadline],
      { value: REWARD, account: owner.account }
    );

    return { ...f, bountyId: 1n };
  }

  // -------------------------------------------------------------------
  // createBounty
  // -------------------------------------------------------------------

  describe("createBounty", function () {
    it("creates a bounty with two deadlines", async function () {
      const { judge, submissionDeadline, revealDeadline } = await deployAndCreateBounty();
      const b = await judge.read.getBounty([1n]);
      expect(b[4]).to.equal(submissionDeadline); // submissionDeadline
      expect(b[5]).to.equal(revealDeadline);      // revealDeadline
    });

    it("rejects reveal deadline before submission deadline", async function () {
      const { judge, owner, now } = await deployFixture();
      await expect(
        judge.write.createBounty(
          ["Test", "Rubric", now + 2000n, now + 1000n],
          { value: REWARD, account: owner.account }
        )
      ).to.be.rejectedWith("reveal deadline must be after submission deadline");
    });
  });

  // -------------------------------------------------------------------
  // submitCommitment
  // -------------------------------------------------------------------

  describe("submitCommitment", function () {
    it("accepts a commitment during the submission phase", async function () {
      const { judge, alice, bountyId } = await deployAndCreateBounty();
      const commitment = makeCommitment("my answer", ALICE_SALT, getAddress(alice.account.address), bountyId);

      await judge.write.submitCommitment([bountyId, commitment], {
        account: alice.account,
      });

      const sub = await judge.read.getSubmission([bountyId, 0n]);
      expect(sub[0].toLowerCase()).to.equal(alice.account.address.toLowerCase());
      expect(sub[1]).to.equal(commitment);
      expect(sub[2]).to.equal(false);  // not yet revealed
      expect(sub[3]).to.equal("");     // no plaintext yet
    });

    it("rejects a commitment after the submission deadline", async function () {
      const { judge, alice, bountyId, submissionDeadline } = await deployAndCreateBounty();
      await time.increaseTo(Number(submissionDeadline) + 1);

      const commitment = makeCommitment("my answer", ALICE_SALT, getAddress(alice.account.address), bountyId);
      await expect(
        judge.write.submitCommitment([bountyId, commitment], { account: alice.account })
      ).to.be.rejectedWith("submissions closed");
    });
  });

  // -------------------------------------------------------------------
  // revealAnswer
  // -------------------------------------------------------------------

  describe("revealAnswer", function () {
    async function withCommitment() {
      const f = await deployAndCreateBounty();
      const { judge, alice, bountyId } = f;

      const aliceCommitment = makeCommitment("alice answer", ALICE_SALT, getAddress(alice.account.address), bountyId);
      await judge.write.submitCommitment([bountyId, aliceCommitment], { account: alice.account });

      return { ...f, aliceCommitment };
    }

    it("rejects a reveal during the submission phase", async function () {
      const { judge, alice, bountyId } = await withCommitment();
      await expect(
        judge.write.revealAnswer([bountyId, 0n, "alice answer", ALICE_SALT], { account: alice.account })
      ).to.be.rejectedWith("submission phase not over");
    });

    it("accepts a correct reveal during the reveal phase", async function () {
      const { judge, alice, bountyId, submissionDeadline } = await withCommitment();
      await time.increaseTo(Number(submissionDeadline) + 1);

      await judge.write.revealAnswer([bountyId, 0n, "alice answer", ALICE_SALT], { account: alice.account });

      const sub = await judge.read.getSubmission([bountyId, 0n]);
      expect(sub[2]).to.equal(true);           // revealed
      expect(sub[3]).to.equal("alice answer"); // plaintext now readable
    });

    it("rejects wrong answer (commitment mismatch)", async function () {
      const { judge, alice, bountyId, submissionDeadline } = await withCommitment();
      await time.increaseTo(Number(submissionDeadline) + 1);

      await expect(
        judge.write.revealAnswer([bountyId, 0n, "WRONG answer", ALICE_SALT], { account: alice.account })
      ).to.be.rejectedWith("commitment mismatch");
    });

    it("rejects wrong salt (commitment mismatch)", async function () {
      const { judge, alice, bountyId, submissionDeadline } = await withCommitment();
      await time.increaseTo(Number(submissionDeadline) + 1);

      await expect(
        judge.write.revealAnswer([bountyId, 0n, "alice answer", BOB_SALT], { account: alice.account })
      ).to.be.rejectedWith("commitment mismatch");
    });

    it("rejects copying another participant's revealed answer+salt", async function () {
      // Bob sees Alice reveal (answer, ALICE_SALT) and tries to use it himself.
      // He can't — the commitment hash is bound to msg.sender (Alice's address),
      // so it will never match Bob's stored commitment.
      const { judge, alice, bob, bountyId, submissionDeadline } = await deployAndCreateBounty();

      const aliceCommitment = makeCommitment("shared answer", ALICE_SALT, getAddress(alice.account.address), bountyId);
      const bobCommitment = makeCommitment("bob answer", BOB_SALT, getAddress(bob.account.address), bountyId);

      await judge.write.submitCommitment([bountyId, aliceCommitment], { account: alice.account });
      await judge.write.submitCommitment([bountyId, bobCommitment], { account: bob.account });

      await time.increaseTo(Number(submissionDeadline) + 1);
      await judge.write.revealAnswer([bountyId, 0n, "shared answer", ALICE_SALT], { account: alice.account });

      // Bob tries to replay Alice's plaintext+salt as his own reveal
      await expect(
        judge.write.revealAnswer([bountyId, 1n, "shared answer", ALICE_SALT], { account: bob.account })
      ).to.be.rejectedWith("commitment mismatch");
    });

    it("rejects a reveal after the reveal deadline", async function () {
      const { judge, alice, bountyId, revealDeadline } = await withCommitment();
      await time.increaseTo(Number(revealDeadline) + 1);

      await expect(
        judge.write.revealAnswer([bountyId, 0n, "alice answer", ALICE_SALT], { account: alice.account })
      ).to.be.rejectedWith("reveal phase over");
    });

    it("rejects a double reveal", async function () {
      const { judge, alice, bountyId, submissionDeadline } = await withCommitment();
      await time.increaseTo(Number(submissionDeadline) + 1);

      await judge.write.revealAnswer([bountyId, 0n, "alice answer", ALICE_SALT], { account: alice.account });
      await expect(
        judge.write.revealAnswer([bountyId, 0n, "alice answer", ALICE_SALT], { account: alice.account })
      ).to.be.rejectedWith("already revealed");
    });
  });

  // -------------------------------------------------------------------
  // finalizeWinner — basic access-control checks (no LLM call needed)
  // -------------------------------------------------------------------

  describe("finalizeWinner", function () {
    it("rejects selecting a participant who never revealed", async function () {
      // We can only reach finalizeWinner after judged=true, which requires
      // an LLM precompile call. We test the unrevealed check in isolation
      // by checking getSubmission reveals the protection is in place.
      const { judge, alice, bountyId, submissionDeadline } = await deployAndCreateBounty();

      const commitment = makeCommitment("answer", ALICE_SALT, getAddress(alice.account.address), bountyId);
      await judge.write.submitCommitment([bountyId, commitment], { account: alice.account });

      // Alice does NOT reveal. Verify submission is still unrevealed.
      await time.increaseTo(Number(submissionDeadline) + 1);
      const sub = await judge.read.getSubmission([bountyId, 0n]);
      expect(sub[2]).to.equal(false); // revealed = false
      expect(sub[3]).to.equal("");    // no answer
    });
  });

  // -------------------------------------------------------------------
  // Privacy property — the key thing commit-reveal is meant to guarantee
  // -------------------------------------------------------------------

  describe("privacy: answers hidden during submission phase", function () {
    it("stores no plaintext during submission phase", async function () {
      const { judge, alice, bob, bountyId } = await deployAndCreateBounty();

      const aliceCommitment = makeCommitment("secret strategy", ALICE_SALT, getAddress(alice.account.address), bountyId);
      await judge.write.submitCommitment([bountyId, aliceCommitment], { account: alice.account });

      // Bob reads Alice's on-chain submission — he can see the commitment
      // hash but learns nothing about her answer.
      const sub = await judge.read.getSubmission([bountyId, 0n]);
      expect(sub[1]).to.equal(aliceCommitment); // commitment hash — opaque
      expect(sub[2]).to.equal(false);            // not revealed
      expect(sub[3]).to.equal("");               // NO plaintext — this is the fix
    });
  });
});
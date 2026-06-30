// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrecompileConsumer} from "./utils/PrecompileConsumer.sol";

interface IRitualWallet {
    function deposit(uint256 lockDuration) external payable;
    function depositFor(address user, uint256 lockDuration) external payable;
    function withdraw(uint256 amount) external;
    function balanceOf(address) external view returns (uint256);
    function lockUntil(address) external view returns (uint256);
}

contract AIJudge is PrecompileConsumer {
    uint256 public constant MAX_SUBMISSIONS = 10;
    uint256 public constant MAX_ANSWER_LENGTH = 2_000;

    uint256 public nextBountyId = 1;

    IRitualWallet wallet =
        IRitualWallet(0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948);

    // -----------------------------------------------------------------------
    // Structs
    // -----------------------------------------------------------------------

    // CHANGED: `answer` is no longer stored on submission — only the
    // commitment hash. `answer` is empty until the participant calls
    // revealAnswer(), at which point it is written and `revealed` flips true.
    struct Submission {
        address submitter;
        bytes32 commitment; // keccak256(answer, salt, submitter, bountyId)
        bool revealed;
        string answer; // empty string until revealed
    }

    // CHANGED: single `deadline` split into two phases.
    struct Bounty {
        address owner;
        string title;
        string rubric;
        uint256 reward;
        uint256 submissionDeadline; // commit before this
        uint256 revealDeadline;     // reveal between submissionDeadline and this
        bool judged;
        bool finalized;
        bytes aiReview;
        uint256 winnerIndex;
        Submission[] submissions;
    }

    struct ConvoHistory {
        string storageType;
        string path;
        string secretsName;
    }

    mapping(uint256 => Bounty) public bounties;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    // CHANGED: emits both deadlines instead of one.
    event BountyCreated(
        uint256 indexed bountyId,
        address indexed owner,
        string title,
        uint256 reward,
        uint256 submissionDeadline,
        uint256 revealDeadline
    );

    // CHANGED: was AnswerSubmitted — now signals a hidden commitment only.
    event CommitmentSubmitted(
        uint256 indexed bountyId,
        uint256 indexed submissionIndex,
        address indexed submitter
    );

    // NEW: emitted when a participant reveals their plaintext answer.
    event AnswerRevealed(
        uint256 indexed bountyId,
        uint256 indexed submissionIndex,
        address indexed submitter
    );

    // Unchanged.
    event AllAnswersJudged(uint256 indexed bountyId, bytes aiReview);

    event WinnerFinalized(
        uint256 indexed bountyId,
        uint256 indexed winnerIndex,
        address indexed winner,
        uint256 reward
    );

    // -----------------------------------------------------------------------
    // Modifiers (unchanged)
    // -----------------------------------------------------------------------

    modifier onlyOwner(uint256 bountyId) {
        require(msg.sender == bounties[bountyId].owner, "not bounty owner");
        _;
    }

    modifier bountyExists(uint256 bountyId) {
        require(bounties[bountyId].owner != address(0), "bounty not found");
        _;
    }

    // -----------------------------------------------------------------------
    // CHANGED: createBounty — takes two deadlines instead of one
    // -----------------------------------------------------------------------

    function createBounty(
        string calldata title,
        string calldata rubric,
        uint256 submissionDeadline,
        uint256 revealDeadline
    ) external payable returns (uint256 bountyId) {
        require(msg.value > 0, "reward required");
        require(
            submissionDeadline > block.timestamp,
            "submission deadline must be in future"
        );
        require(
            revealDeadline > submissionDeadline,
            "reveal deadline must be after submission deadline"
        );

        bountyId = nextBountyId++;

        Bounty storage bounty = bounties[bountyId];
        bounty.owner = msg.sender;
        bounty.title = title;
        bounty.rubric = rubric;
        bounty.reward = msg.value;
        bounty.submissionDeadline = submissionDeadline;
        bounty.revealDeadline = revealDeadline;
        bounty.winnerIndex = type(uint256).max;

        emit BountyCreated(
            bountyId,
            msg.sender,
            title,
            msg.value,
            submissionDeadline,
            revealDeadline
        );
    }

    // -----------------------------------------------------------------------
    // NEW: submitCommitment — replaces submitAnswer
    // Participants submit only a hash during the submission phase.
    // commitment = keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId))
    // Binding msg.sender + bountyId prevents copying someone else's commitment.
    // -----------------------------------------------------------------------

    function submitCommitment(
        uint256 bountyId,
        bytes32 commitment
    ) external bountyExists(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(
            block.timestamp < bounty.submissionDeadline,
            "submissions closed"
        );
        require(!bounty.judged, "already judged");
        require(!bounty.finalized, "already finalized");
        require(
            bounty.submissions.length < MAX_SUBMISSIONS,
            "too many submissions"
        );

        bounty.submissions.push(
            Submission({
                submitter: msg.sender,
                commitment: commitment,
                revealed: false,
                answer: ""
            })
        );

        emit CommitmentSubmitted(
            bountyId,
            bounty.submissions.length - 1,
            msg.sender
        );
    }

    // -----------------------------------------------------------------------
    // NEW: revealAnswer — only valid in the reveal window
    // The contract recomputes the hash and checks it matches the commitment.
    // Only revealed answers are eligible for judging.
    // -----------------------------------------------------------------------

    function revealAnswer(
        uint256 bountyId,
        uint256 submissionIndex,
        string calldata answer,
        bytes32 salt
    ) external bountyExists(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(
            block.timestamp >= bounty.submissionDeadline,
            "submission phase not over"
        );
        require(
            block.timestamp < bounty.revealDeadline,
            "reveal phase over"
        );
        require(
            submissionIndex < bounty.submissions.length,
            "invalid index"
        );

        Submission storage sub = bounty.submissions[submissionIndex];

        require(sub.submitter == msg.sender, "not your submission");
        require(!sub.revealed, "already revealed");
        require(bytes(answer).length <= MAX_ANSWER_LENGTH, "answer too long");

        // Recompute commitment and verify — same formula used off-chain.
        bytes32 check = keccak256(
            abi.encodePacked(answer, salt, msg.sender, bountyId)
        );
        require(check == sub.commitment, "commitment mismatch");

        sub.revealed = true;
        sub.answer = answer;

        emit AnswerRevealed(bountyId, submissionIndex, msg.sender);
    }

    // -----------------------------------------------------------------------
    // CHANGED: judgeAll — now requires reveal deadline has passed and at
    // least one answer was revealed. Everything else is unchanged — the real
    // Ritual LLM precompile call remains identical.
    // -----------------------------------------------------------------------

    function judgeAll(
        uint256 bountyId,
        bytes calldata llmInput
    ) external bountyExists(bountyId) onlyOwner(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(
            block.timestamp >= bounty.revealDeadline,
            "reveal phase not over"
        );
        require(!bounty.judged, "already judged");
        require(!bounty.finalized, "already finalized");

        // Only judge if at least one participant actually revealed.
        uint256 revealedCount = 0;
        for (uint256 i = 0; i < bounty.submissions.length; i++) {
            if (bounty.submissions[i].revealed) revealedCount++;
        }
        require(revealedCount > 0, "no revealed answers");

        // Ritual LLM precompile call — unchanged from workshop.
        bytes memory output = _executePrecompile(
            LLM_INFERENCE_PRECOMPILE,
            llmInput
        );

        (
            bool hasError,
            bytes memory completionData,
            ,
            string memory errorMessage,

        ) = abi.decode(output, (bool, bytes, bytes, string, ConvoHistory));

        require(!hasError, errorMessage);

        bounty.judged = true;
        bounty.aiReview = completionData;

        emit AllAnswersJudged(bountyId, completionData);
    }

    // -----------------------------------------------------------------------
    // CHANGED: finalizeWinner — added one extra require: the chosen winner
    // must have actually revealed a valid answer. Prevents the AI result
    // from accidentally (or maliciously) pointing at an unrevealed slot.
    // -----------------------------------------------------------------------

    function finalizeWinner(
        uint256 bountyId,
        uint256 winnerIndex
    ) external bountyExists(bountyId) onlyOwner(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(bounty.judged, "not judged yet");
        require(!bounty.finalized, "already finalized");
        require(winnerIndex < bounty.submissions.length, "invalid index");

        // NEW: unrevealed submissions can never win.
        require(
            bounty.submissions[winnerIndex].revealed,
            "winner did not reveal"
        );

        bounty.finalized = true;
        bounty.winnerIndex = winnerIndex;

        address winner = bounty.submissions[winnerIndex].submitter;
        uint256 reward = bounty.reward;
        bounty.reward = 0;

        (bool ok, ) = payable(winner).call{value: reward}("");
        require(ok, "payment failed");

        emit WinnerFinalized(bountyId, winnerIndex, winner, reward);
    }

    // -----------------------------------------------------------------------
    // Views — updated to expose new fields
    // -----------------------------------------------------------------------

    function getBounty(
        uint256 bountyId
    )
        external
        view
        bountyExists(bountyId)
        returns (
            address owner,
            string memory title,
            string memory rubric,
            uint256 reward,
            uint256 submissionDeadline,
            uint256 revealDeadline,
            bool judged,
            bool finalized,
            uint256 submissionCount,
            uint256 winnerIndex,
            bytes memory aiReview
        )
    {
        Bounty storage bounty = bounties[bountyId];
        return (
            bounty.owner,
            bounty.title,
            bounty.rubric,
            bounty.reward,
            bounty.submissionDeadline,
            bounty.revealDeadline,
            bounty.judged,
            bounty.finalized,
            bounty.submissions.length,
            bounty.winnerIndex,
            bounty.aiReview
        );
    }

    // CHANGED: returns commitment + revealed status alongside answer.
    // answer is empty string until the participant reveals.
    function getSubmission(
        uint256 bountyId,
        uint256 index
    )
        external
        view
        bountyExists(bountyId)
        returns (
            address submitter,
            bytes32 commitment,
            bool revealed,
            string memory answer
        )
    {
        Bounty storage bounty = bounties[bountyId];
        require(index < bounty.submissions.length, "invalid index");
        Submission storage sub = bounty.submissions[index];
        return (sub.submitter, sub.commitment, sub.revealed, sub.answer);
    }
}

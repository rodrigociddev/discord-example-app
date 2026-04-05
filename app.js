import "dotenv/config";
import express from "express";
import cron from "node-cron";
import {
  InteractionType,
  InteractionResponseType,
  InteractionResponseFlags,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from "discord-interactions";
import { getRandomEmoji, DiscordRequest } from "./utils.js";

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

// Store for in-progress games. In production, you'd want to use a DB
const activeGames = {};

// ---------------------------------------------------------------------------
// QOTD in-memory store. In production, replace with a real database.
// ---------------------------------------------------------------------------
const qotdState = {
  questions: [], // [{ id, question, image?, addedBy, addedAt }]
  questionChannel: null, // Discord channel ID to post the QOTD into
  queueMode: true, // true = queue (FIFO), false = random "hat-pull"
  threadEnabled: true,
  mentionEnabled: false,
  scheduledTime: -1, // -1 = disabled; otherwise military-time integer e.g. 900
  qotdRole: null, // Role ID to mention; set via /question set role
  _nextId: 1,
};

// Active cron job handle so we can cancel and reschedule it
let cronJob = null;

// ---------------------------------------------------------------------------
// Helper: get next question (queue or random)
// ---------------------------------------------------------------------------
function getNextQuestion() {
  if (qotdState.questions.length === 0) return null;
  if (qotdState.queueMode) {
    return qotdState.questions.shift();
  }
  const idx = Math.floor(Math.random() * qotdState.questions.length);
  return qotdState.questions.splice(idx, 1)[0];
}

// ---------------------------------------------------------------------------
// Helper: convert military-time integer (e.g. 930) to a cron expression.
// Returns null if time is invalid or disabled (-1).
// ---------------------------------------------------------------------------
function militaryTimeToCron(militaryTime) {
  if (militaryTime === -1 || militaryTime == null) return null;
  const str = String(militaryTime).padStart(4, "0");
  const hours = parseInt(str.slice(0, 2), 10);
  const minutes = parseInt(str.slice(2, 4), 10);
  if (hours > 23 || minutes > 59) return null;
  return `${minutes} ${hours} * * *`;
}

// ---------------------------------------------------------------------------
// Core QOTD poster — used by both the cron job and /question send.
// Returns { ok: true, question } or { ok: false, reason: string }
// ---------------------------------------------------------------------------
async function postQotd() {
  if (!qotdState.questionChannel) {
    return {
      ok: false,
      reason:
        "No question channel has been configured. Use `/question set questionchannel`.",
    };
  }
  if (qotdState.mentionEnabled && !qotdState.qotdRole) {
    return {
      ok: false,
      reason:
        "No role has been configured but mentions are enabled. Use `/question set role`.",
    };
  }

  const question = getNextQuestion();
  if (!question) {
    return { ok: false, reason: "There are no questions in the pool/queue." };
  }

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // Optional role mention sent as plain content so Discord pings the role.
  // The banner below is Components V2 and cannot contain mentions, so we
  // send the ping as the top-level message content alongside the components.
  const mentionContent = qotdState.mentionEnabled
    ? `<@&${qotdState.qotdRole}>`
    : undefined;

  // Components V2 banner layout:
  //   [Container]
  //     [Section]  ✢ QOTD header + date
  //     [Separator]
  //     [Text Display]  the question body
  const messageBody = {
    // Top-level mention so Discord actually pings the role
    ...(mentionContent && { content: mentionContent }),
    flags: 1 << 15, // IS_COMPONENTS_V2
    components: [
      {
        type: MessageComponentTypes.CONTAINER, // 17
        accent_color: 0x5865f2, // Discord blurple
        components: [
          {
            type: MessageComponentTypes.SECTION, // 9
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY, // 10
                content: `## ✢ Question of the Day\n${dateStr}`,
              },
            ],
            accessory: {
              type: MessageComponentTypes.THUMBNAIL, // 11
              media: {
                url: question.image
                  ? question.image
                  : "https://cdn.discordapp.com/attachments/1254492977406021705/1475974807911665787/image.png?ex=69bbc868&is=69ba76e8&hm=ebe6eb8105df4b4cf3982a6a0fae26c139e6797207590d45b8879e1b3f723587&",
              },
              description: "QOTD",
              spoiler: false,
            },
          },
          {
            type: MessageComponentTypes.SEPARATOR, // 14
            divider: true,
            spacing: 1, // SMALL
          },
          {
            type: MessageComponentTypes.TEXT_DISPLAY, // 10
            content: question.question,
          },
        ],
      },
    ],
  };

  try {
    // Step 1 — post the QOTD message and await the full response object.
    // DiscordRequest must return the parsed JSON body for this to work;
    // confirm your implementation does `return await res.json()` at the end.
    const message = await DiscordRequest(
      `channels/${qotdState.questionChannel}/messages`,
      { method: "POST", body: messageBody },
    );

    console.log(
      `[QOTD] Message posted. id=${message?.id} threadEnabled=${qotdState.threadEnabled} message=${message}`,
    );

    // Step 2 — only attempt thread creation once we have a confirmed message ID.
    if (qotdState.threadEnabled && message?.id) {
      await DiscordRequest(
        `channels/${qotdState.questionChannel}/messages/${message.id}/threads`,
        {
          method: "POST",
          body: {
            name: `✢ QOTD – ${dateStr}`,
            auto_archive_duration: 1440, // archive after 24 h of inactivity
          },
        },
      );
      console.log(`[QOTD] Thread created on message ${message.id}`);
    }

    return { ok: true, question };
  } catch (err) {
    console.error("Error posting QOTD:", err);
    return {
      ok: false,
      reason:
        "Failed to post to Discord. Check that the bot has permission to post in the question channel.",
    };
  }
}

// ---------------------------------------------------------------------------
// (Re)schedule the cron job based on qotdState.scheduledTime.
// Safe to call multiple times — always cancels the previous job first.
// ---------------------------------------------------------------------------
function reschedule() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }

  const expression = militaryTimeToCron(qotdState.scheduledTime);
  if (!expression) return; // scheduling disabled

  cronJob = cron.schedule(
    expression,
    async () => {
      console.log(
        `[QOTD cron] Firing at scheduled time ${qotdState.scheduledTime}`,
      );
      const result = await postQotd();
      if (!result.ok) {
        console.error("[QOTD cron] Failed to post QOTD:", result.reason);
      } else {
        console.log(`[QOTD cron] Posted question #${result.question.id}`);
      }
    },
    { timezone: "America/New_York" },
  );

  console.log(`[QOTD] Cron scheduled: "${expression}" (America/New_York)`);
}

// ---------------------------------------------------------------------------
// Interactions endpoint
// ---------------------------------------------------------------------------
app.post(
  "/interactions",
  verifyKeyMiddleware(process.env.PUBLIC_KEY),
  async function (req, res) {
    const { type, id, data } = req.body;

    // ── Verification ping ──────────────────────────────────────────────────
    if (type === InteractionType.PING) {
      return res.send({ type: InteractionResponseType.PONG });
    }

    // ── Slash commands ─────────────────────────────────────────────────────
    if (type === InteractionType.APPLICATION_COMMAND) {
      const { name } = data;

      // "test" command
      if (name === "test") {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: `hello world ${getRandomEmoji()}`,
              },
            ],
          },
        });
      }

      // ── "question" command ───────────────────────────────────────────────
      if (name === "question") {
        const subcommand = data.options[0];
        const subName = subcommand.name;

        // question add
        if (subName === "add") {
          const context = req.body.context;
          const userId =
            context === 0 ? req.body.member.user.id : req.body.user.id;

          const questionText = subcommand.options.find(
            (o) => o.name === "question",
          )?.value;
          const image =
            subcommand.options.find((o) => o.name === "image")?.value ?? null;

          const entry = {
            id: qotdState._nextId++,
            question: questionText,
            image,
            addedBy: userId,
            addedAt: new Date().toISOString(),
          };
          qotdState.questions.push(entry);

          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags:
                InteractionResponseFlags.EPHEMERAL |
                InteractionResponseFlags.IS_COMPONENTS_V2,
              components: [
                {
                  type: MessageComponentTypes.TEXT_DISPLAY,
                  content: `✅ Question #${entry.id} added to the ${
                    qotdState.queueMode ? "queue" : "pool"
                  }:\n> ${questionText}`,
                },
              ],
            },
          });
        }

        // question get
        if (subName === "get") {
          if (qotdState.questions.length === 0) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags:
                  InteractionResponseFlags.EPHEMERAL |
                  InteractionResponseFlags.IS_COMPONENTS_V2,
                components: [
                  {
                    type: MessageComponentTypes.TEXT_DISPLAY,
                    content:
                      "📭 There are no questions in the pool/queue right now.",
                  },
                ],
              },
            });
          }

          const list = qotdState.questions
            .map((q, i) => `**${i + 1}.** [#${q.id}] ${q.question}`)
            .join("\n");

          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags:
                InteractionResponseFlags.EPHEMERAL |
                InteractionResponseFlags.IS_COMPONENTS_V2,
              components: [
                {
                  type: MessageComponentTypes.TEXT_DISPLAY,
                  content: `📋 **Questions in ${
                    qotdState.queueMode ? "queue" : "pool"
                  } (${qotdState.questions.length}):**\n${list}`,
                },
              ],
            },
          });
        }

        // question remove
        if (subName === "remove") {
          if (qotdState.questions.length === 0) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags:
                  InteractionResponseFlags.EPHEMERAL |
                  InteractionResponseFlags.IS_COMPONENTS_V2,
                components: [
                  {
                    type: MessageComponentTypes.TEXT_DISPLAY,
                    content: "📭 There are no questions to remove.",
                  },
                ],
              },
            });
          }

          const selectOptions = qotdState.questions.slice(0, 25).map((q) => ({
            label: q.question.substring(0, 100),
            value: String(q.id),
            description: `#${q.id} — added by <@${q.addedBy}>`,
          }));

          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags:
                InteractionResponseFlags.EPHEMERAL |
                InteractionResponseFlags.IS_COMPONENTS_V2,
              components: [
                {
                  type: MessageComponentTypes.TEXT_DISPLAY,
                  content: "Select a question to remove:",
                },
                {
                  type: MessageComponentTypes.ACTION_ROW,
                  components: [
                    {
                      type: MessageComponentTypes.STRING_SELECT,
                      custom_id: "qotd_remove_select",
                      options: selectOptions,
                      placeholder: "Choose a question…",
                    },
                  ],
                },
              ],
            },
          });
        }

        // question send — manually fire the QOTD right now
        if (subName === "send") {
          const result = await postQotd();
          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags:
                InteractionResponseFlags.EPHEMERAL |
                InteractionResponseFlags.IS_COMPONENTS_V2,
              components: [
                {
                  type: MessageComponentTypes.TEXT_DISPLAY,
                  content: result.ok
                    ? `✅ QOTD posted! Question #${result.question.id} sent to <#${qotdState.questionChannel}>.`
                    : `❌ Could not post QOTD: ${result.reason}`,
                },
              ],
            },
          });
        }

        // question set <subgroup>
        if (subName === "set") {
          const setSubcommand = subcommand.options[0];
          const setName = setSubcommand.name;

          // question set questionchannel
          if (setName === "questionchannel") {
            const channel = setSubcommand.options.find(
              (o) => o.name === "channel",
            )?.value;
            qotdState.questionChannel = channel;
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags:
                  InteractionResponseFlags.EPHEMERAL |
                  InteractionResponseFlags.IS_COMPONENTS_V2,
                components: [
                  {
                    type: MessageComponentTypes.TEXT_DISPLAY,
                    content: `⚙️ QOTD output channel set to <#${channel}>.`,
                  },
                ],
              },
            });
          }

          // question set enablequeue
          if (setName === "enablequeue") {
            const value = setSubcommand.options.find(
              (o) => o.name === "queue",
            )?.value;
            qotdState.queueMode = value === true || value === "true";
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags:
                  InteractionResponseFlags.EPHEMERAL |
                  InteractionResponseFlags.IS_COMPONENTS_V2,
                components: [
                  {
                    type: MessageComponentTypes.TEXT_DISPLAY,
                    content: `⚙️ Queue mode **${
                      qotdState.queueMode ? "enabled" : "disabled"
                    }**. ${
                      qotdState.queueMode
                        ? "Questions will be sent in order."
                        : "Questions will be drawn randomly."
                    }`,
                  },
                ],
              },
            });
          }

          // question set enablethread
          if (setName === "enablethread") {
            const value = setSubcommand.options.find(
              (o) => o.name === "thread",
            )?.value;
            qotdState.threadEnabled = value === true || value === "true";
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags:
                  InteractionResponseFlags.EPHEMERAL |
                  InteractionResponseFlags.IS_COMPONENTS_V2,
                components: [
                  {
                    type: MessageComponentTypes.TEXT_DISPLAY,
                    content: `⚙️ Auto-thread **${
                      qotdState.threadEnabled ? "enabled" : "disabled"
                    }**.`,
                  },
                ],
              },
            });
          }

          // question set enablemention
          if (setName === "enablemention") {
            const value = setSubcommand.options.find(
              (o) => o.name === "mention",
            )?.value;
            qotdState.mentionEnabled = value === true || value === "true";
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags:
                  InteractionResponseFlags.EPHEMERAL |
                  InteractionResponseFlags.IS_COMPONENTS_V2,
                components: [
                  {
                    type: MessageComponentTypes.TEXT_DISPLAY,
                    content: `⚙️ QOTD role mention **${
                      qotdState.mentionEnabled ? "enabled" : "disabled"
                    }**.`,
                  },
                ],
              },
            });
          }

          // question set schedule
          if (setName === "schedule") {
            const time = setSubcommand.options.find(
              (o) => o.name === "scheduledtime",
            )?.value;
            qotdState.scheduledTime = time;
            reschedule(); // apply new time immediately
            const msg =
              time === -1
                ? "⚙️ Scheduled posting **disabled**."
                : `⚙️ QOTD scheduled for **${String(time).padStart(4, "0")} EST** daily. Cron job updated.`;
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags:
                  InteractionResponseFlags.EPHEMERAL |
                  InteractionResponseFlags.IS_COMPONENTS_V2,
                components: [
                  {
                    type: MessageComponentTypes.TEXT_DISPLAY,
                    content: msg,
                  },
                ],
              },
            });
          }

          // question set role
          if (setName === "role") {
            const role = setSubcommand.options.find(
              (o) => o.name === "role",
            )?.value;
            qotdState.qotdRole = role;
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags:
                  InteractionResponseFlags.EPHEMERAL |
                  InteractionResponseFlags.IS_COMPONENTS_V2,
                components: [
                  {
                    type: MessageComponentTypes.TEXT_DISPLAY,
                    content: `⚙️ QOTD mention role updated to <@&${role}>.`,
                  },
                ],
              },
            });
          }

          console.error(`unknown set subcommand: ${setName}`);
          return res.status(400).json({ error: "unknown set subcommand" });
        }

        console.error(`unknown question subcommand: ${subName}`);
        return res.status(400).json({ error: "unknown question subcommand" });
      }

      console.error(`unknown command: ${name}`);
      return res.status(400).json({ error: "unknown command" });
    }

    // ── Message component interactions ─────────────────────────────────────
    if (type === InteractionType.MESSAGE_COMPONENT) {
      const componentId = data.custom_id;

      // QOTD: remove select
      if (componentId === "qotd_remove_select") {
        const targetId = parseInt(data.values[0], 10);
        const idx = qotdState.questions.findIndex((q) => q.id === targetId);

        if (idx === -1) {
          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags:
                InteractionResponseFlags.EPHEMERAL |
                InteractionResponseFlags.IS_COMPONENTS_V2,
              components: [
                {
                  type: MessageComponentTypes.TEXT_DISPLAY,
                  content:
                    "❌ That question was not found (it may have already been removed).",
                },
              ],
            },
          });
        }

        const [removed] = qotdState.questions.splice(idx, 1);
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags:
              InteractionResponseFlags.EPHEMERAL |
              InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: `🗑️ Removed question #${removed.id}:\n> ${removed.question}`,
              },
            ],
          },
        });
      }

      return;
    }

    console.error("unknown interaction type", type);
    return res.status(400).json({ error: "unknown interaction type" });
  },
);

app.listen(PORT, () => {
  console.log("Listening on port", PORT);
  // Kick off cron job if a schedule was already configured (e.g. loaded from DB on startup)
  reschedule();
});

import "dotenv/config";
import { capitalize, InstallGlobalCommands } from "./utils.js";

// Simple test command
const TEST_COMMAND = {
  name: "test",
  description: "Basic command",
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const QOTD_COMMAND = {
  name: "question",
  description: "QOTD",
  options: [
    {
      name: "add",
      type: 1,
      description: "Add a question to the pool/queue.",
      options: [
        {
          type: 3,
          name: "question",
          description: "Question of the day field.",
          required: true,
        },
        {
          type: 3,
          name: "image",
          description: "Optional image field, provide a link to the img.",
          required: false,
        },
      ],
    },
    {
      name: "get",
      type: 1,
      description: "Get all questions currently in the pool/queue.",
    },
    {
      name: "remove",
      type: 1,
      description: "Remove a question from the pool/queue.",
      options: [],
    },
    {
      // Manually fire today's QOTD right now, identical to what the cron job does
      name: "send",
      type: 1,
      description:
        "Immediately post the next question of the day to the configured channel.",
    },
    {
      name: "set",
      type: 2,
      description: "Set bot parameters.",
      options: [
        {
          name: "questionchannel",
          type: 1,
          description: "Set text channel id where bot will send the qotd.",
          options: [
            {
              type: 7,
              name: "channel",
              description:
                "Exact channel id for bot to use. Right click channel > copy channel ID.",
              required: true,
            },
          ],
        },
        {
          name: "enablequeue",
          type: 1,
          description:
            "Enable queue mode. True means queue mode, false means hat-pulling mode.",
          options: [
            {
              type: 5,
              name: "queue",
              description: "Default true.",
              choices: ["true", "false"],
              required: true,
            },
          ],
        },
        {
          name: "enablethread",
          type: 1,
          description:
            "Enable bot creating a thread with qotd. True means bot will create a thread automatically",
          options: [
            {
              type: 5,
              name: "thread",
              description: "Default true.",
              choices: ["true", "false"],
              required: true,
            },
          ],
        },
        {
          name: "enablemention",
          type: 1,
          description:
            "Should bot mention qotd role? Default false. Dont forget to set the role with /question set role!",
          options: [
            {
              type: 5,
              name: "mention",
              description: "Default false.",
              choices: ["true", "false"],
              required: true,
            },
          ],
        },
        {
          name: "schedule",
          type: 1,
          description: "Schedule the qotd for a certain time.",
          options: [
            {
              type: 4,
              name: "scheduledtime",
              description:
                "Provide an integer in military time (e.g. 0900 for 9 a.m.). Set to -1 to disable. Timezone in EST.",
              required: true,
            },
          ],
        },
        {
          // Configure which role gets pinged when the QOTD is posted
          name: "role",
          type: 1,
          description:
            "Set the role that gets mentioned when the QOTD is posted. ",
          options: [
            {
              type: 8, // ROLE type
              name: "role",
              description:
                "The role id to mention. Right click role > copy role id",
              required: true,
            },
          ],
        },
      ],
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 2],
};

const ALL_COMMANDS = [TEST_COMMAND, QOTD_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);

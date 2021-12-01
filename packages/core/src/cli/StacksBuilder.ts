import { interpret, actions, assign, createMachine } from "xstate";
import { Config } from "../config";
import { Stacks } from "../stacks";
import { synth } from "../";
import path from "path";
import fs from "fs-extra";
import crypto from "crypto";

type Events =
  | { type: "FILE_CHANGE" }
  | { type: "TRIGGER_DEPLOY" }
  | { type: "BUILD_SUCCESS" }
  | {
      type: "done.invoke.synth";
      data: string;
    };

type Context = {
  dirty: boolean;
  deployedHash: string;
  pendingHash: string;
};

function sleep(name: string, duration = 1000) {
  return function () {
    console.log(name);
    return new Promise((r) => setTimeout(r, duration));
  };
}

const machine = createMachine<Context, Events>(
  {
    initial: "synthing",
    id: "top",
    states: {
      idle: {
        on: {
          FILE_CHANGE: "building",
        },
      },
      building: {
        entry: assign<Context>({
          dirty: false,
        }),
        invoke: {
          src: "build",
          onDone: [
            {
              cond: "isDirty",
              target: "building",
            },
            {
              target: "synthing",
            },
          ],
          onError: [
            {
              cond: "isDirty",
              target: "building",
            },
            {
              target: "idle",
            },
          ],
        },
      },
      synthing: {
        invoke: {
          src: "synth",
          onDone: [
            {
              cond: "isDirty",
              target: "building",
            },
            {
              cond: "isChanged",
              target: "deployable",
              actions: actions.assign({
                pendingHash: (_, evt) => evt.data,
              }),
            },
            {
              target: "idle",
            },
          ],
          onError: [
            {
              cond: "isDirty",
              target: "building",
            },
            {
              target: "idle",
            },
          ],
        },
      },
      deployable: {
        on: {
          TRIGGER_DEPLOY: "deploying",
          FILE_CHANGE: "building",
        },
      },
      deploying: {
        invoke: {
          src: "deploy",
          onDone: [
            {
              cond: "isDirty",
              target: "building",
              actions: actions.assign({
                deployedHash: (ctx) => ctx.pendingHash,
              }),
            },
            {
              target: "idle",
              actions: actions.assign({
                deployedHash: (ctx) => ctx.pendingHash,
              }),
            },
          ],
        },
      },
    },
    on: {
      FILE_CHANGE: {
        actions: actions.assign({
          dirty: (_ctx) => true,
        }),
      },
    },
  },
  {
    services: {
      build: sleep("build"),
      deploy: sleep("deploy"),
      synth: sleep("synth"),
    },
    guards: {
      isDirty,
      isChanged,
    },
  }
);

// TODO: The arguments here are hacky because we need to access code from cdkHelper. Should be refactored so that cdkHelpers don't really exist and everything is done inside here.
export function useStacksBuilder(
  root: string,
  config: Config,
  cdkOptions: any,
  deployFunc: any
) {
  const cdkOutPath = path.join(root, cdkOptions.output);
  const service = interpret(
    machine
      .withConfig({
        services: {
          build: async () => {
            await Stacks.build(root, config);
          },
          synth: async () => {
            await synth(cdkOptions);
            return generateChecksum(cdkOutPath);
          },
          deploy: async () => {
            await deployFunc(cdkOptions);
          },
        },
      })
      .withContext({
        dirty: false,
        pendingHash: "",
        deployedHash: generateChecksum(cdkOutPath),
      })
  );
  service.start();
  return service;
}

function isChanged(ctx: Context, evt: Events) {
  if (evt.type === "done.invoke.synth") return evt.data !== ctx.deployedHash;
  return false;
}

function isDirty(ctx: Context) {
  return ctx.dirty;
}

function generateChecksum(cdkOutPath: string) {
  const manifestPath = path.join(cdkOutPath, "manifest.json");
  const cdkManifest = fs.readJsonSync(manifestPath);
  const checksumData = Object.values(cdkManifest.artifacts)
    .filter((item: any) => item.type === "aws:cloudformation:stack")
    .map((stack: any) => {
      const templatePath = path.join(
        cdkOutPath,
        `${stack.displayName}.template.json`
      );
      const templateContent = fs.readFileSync(templatePath);
      return templateContent;
    })
    .join("\n");
  const hash = crypto.createHash("sha256").update(checksumData).digest("hex");
  return hash;
}

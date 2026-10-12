import { EOL } from "os"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceRef } from "@/effect/instance-ref"
import { Doctor } from "@/workbench/doctor"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"

export const WorkbenchCommand = cmd({
  command: "workbench",
  describe: "spicy workbench utilities",
  builder: (yargs) => yargs.command(DoctorCommand).demandCommand(),
  async handler() {},
})

const DoctorCommand = effectCmd({
  command: "doctor",
  describe: "check language servers, checkers, test runners and debug adapters",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false, describe: "print the report as JSON" }),
  handler: Effect.fn("Cli.debug.workbench.doctor")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const report = yield* Doctor.report({
      directory: ctx.directory,
      lsp: (yield* config.get()).lsp,
      experimentalLspTy: flags.experimentalLspTy,
    }).pipe(Effect.provide(LayerNode.compile(AppProcess.node)))
    process.stdout.write((args.json ? JSON.stringify(report, null, 2) : Doctor.table(report)) + EOL)
  }),
})

import {
  commands,
  ExtensionContext,
  languages,
  ProgressLocation,
  RelativePattern,
  TextDocument,
  Uri,
  extensions,
  ViewColumn,
  window,
  workspace,
} from "vscode"

const output = window.createOutputChannel("Format All Files")

// Resolvers for documents currently being formatted, keyed by uri.
// The sentinel formatter calls these when the formatter chain reaches its end.
const sentinelWaiters = new Map<string, () => void>()

export function activate(context: ExtensionContext) {
  context.subscriptions.push(
    output,
    // Add "rssaromeo.format-all-files-patient" as the LAST entry of
    // multiFormatter.formatterList. It makes no edits; it only signals that
    // every earlier formatter in the chain has finished.
    languages.registerDocumentFormattingEditProvider(
      { pattern: "**" },
      {
        provideDocumentFormattingEdits(document) {
          sentinelWaiters.get(document.uri.toString())?.()
          return []
        },
      },
    ),
    commands.registerCommand("formatAllFiles.run", () =>
      run(undefined),
    ),
    commands.registerCommand(
      "formatAllFiles.runOnFolder",
      (folder: Uri) => run(folder),
    ),
  )
}

export function deactivate() {}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function isDocumentOpen(uri: Uri) {
  return window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => {
      const input = tab.input as { uri?: Uri } | undefined
      return input?.uri?.toString() === uri.toString()
    }),
  )
}

async function findTargets(folder: Uri | undefined) {
  const config = workspace.getConfiguration("formatAllFiles")
  const include = config.get<string>("include")!
  const exclude = config.get<string>("exclude")!
  const pattern =
    folder ? new RelativePattern(folder, include) : include
  return workspace.findFiles(pattern, exclude)
}
async function activateFormatter(formatterId: string | undefined) {
  if (!formatterId) return

  const extension = extensions.getExtension(formatterId)

  if (!extension) {
    throw new Error(
      `Formatter extension "${formatterId}" is not installed.`,
    )
  }

  if (!extension.isActive) {
    await extension.activate()
  }
}
/**
 * Formats a single document and does not return until the document has
 * stopped changing. Chained formatters (like Multi Formatter) edit the
 * document several times, so a single command returning is not enough.
 */
async function formatOne(uri: Uri, formatCommand: string) {
  const config = workspace.getConfiguration("formatAllFiles")
  const settleMs = config.get<number>("settleMs")!
  const maxWaitMs = config.get<number>("maxWaitMs")!
  const save = config.get<boolean>("save")!
  const closeOpened = config.get<boolean>("closeOpenedEditors")!

  const wasOpen = isDocumentOpen(uri)
  const document: TextDocument = await workspace.openTextDocument(uri)

  let lastChange = Date.now()
  const changeSub = workspace.onDidChangeTextDocument((e) => {
    if (e.document === document) lastChange = Date.now()
  })

  try {
    // Many formatters only work when the document is the active editor
    await window.showTextDocument(document, {
      preview: false,
      viewColumn: ViewColumn.Active,
    })
    const defaultFormatter = workspace
      .getConfiguration("editor", document)
      .get<string | undefined>("defaultFormatter")

    if (!defaultFormatter) return
    activateFormatter(defaultFormatter)

    if (defaultFormatter !== "Jota0222.multi-formatter") {
      // Not a chained formatter: a single normal pass, wait for it to finish
      await commands.executeCommand("editor.action.formatDocument")
    } else {
      const key = uri.toString()
      const sentinel = new Promise<void>((resolve) =>
        sentinelWaiters.set(key, resolve),
      )
      let timer: NodeJS.Timeout
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `formatter chain never reached the sentinel within ${maxWaitMs}ms. ` +
                  `Is "rssaromeo.format-all-files-patient" the last entry of multiFormatter.formatterList?`,
              ),
            ),
          maxWaitMs,
        )
      })
      try {
        await commands.executeCommand(formatCommand)
        await Promise.race([sentinel, timeout])
      } finally {
        clearTimeout(timer!)
        sentinelWaiters.delete(key)
      }
    }

    if (save && document.isDirty) {
      if (!(await document.save()))
        throw new Error(`Failed to save ${uri.fsPath}`)
    }

    // Saving can trigger more edits (format on save, code actions): settle again
    if (settleMs > 0) {
      const start = Date.now()
      while (Date.now() - Math.max(lastChange, start) < settleMs) {
        await sleep(
          Math.min(
            50,
            Date.now() - Math.max(lastChange, start),
            settleMs,
          ),
        )
      }
    }
    if (save && document.isDirty) {
      if (!(await document.save()))
        throw new Error(`Failed to save ${uri.fsPath}`)
    }

    if (closeOpened && !wasOpen) {
      await commands.executeCommand(
        "workbench.action.closeActiveEditor",
      )
    }
  } finally {
    changeSub.dispose()
  }
}

async function run(folder: Uri | undefined) {
  const formatCommand = workspace
    .getConfiguration("formatAllFiles")
    .get<string>("formatCommand")!

  const targets = await findTargets(folder)
  if (targets.length === 0) {
    window.showInformationMessage(
      "Format All Files: no files matched.",
    )
    return
  }

  const failures: { path: string; error: unknown }[] = []
  let done = 0
  let cancelled = false

  output.clear()
  output.show(true)
  output.appendLine(
    `Formatting ${targets.length} files with ${formatCommand}`,
  )

  await window.withProgress(
    {
      location: ProgressLocation.Notification,
      title: "Formatting files",
      cancellable: true,
    },
    async (progress, token) => {
      for (const uri of targets) {
        if (token.isCancellationRequested) {
          cancelled = true
          break
        }
        progress.report({
          message: `${done + 1}/${targets.length} ${workspace.asRelativePath(uri)}`,
          increment: 100 / targets.length,
        })
        try {
          await formatOne(uri, formatCommand)
          output.appendLine(`OK    ${uri.fsPath}`)
        } catch (error) {
          // Not swallowed: logged per file and reported in the final summary
          failures.push({ path: uri.fsPath, error })
          output.appendLine(
            `FAIL  ${uri.fsPath}\n      ${String(error)}`,
          )
        }
        done++
      }
    },
  )

  const summary = `Format All Files: ${done - failures.length} formatted, ${failures.length} failed${cancelled ? " (cancelled)" : ""}.`
  output.appendLine(summary)
  if (failures.length > 0) {
    window.showWarningMessage(
      summary + " See the Format All Files output.",
    )
  } else {
    window.showInformationMessage(summary)
  }
}

// extension.js

const vscode = require("vscode");
const axios = require("axios");
const { generateText } = require("ai");
const { createOpenAI } = require("@ai-sdk/openai");
const { generateObject } = require("ai");
const { z } = require("zod");

let openai = null;

let statusBarItem;

let diagnosticCollection;

function activate(context) {
  // 在activate函数中初始化diagnosticCollection
  diagnosticCollection =
    vscode.languages.createDiagnosticCollection("typoCorrections");
  // Ensure apiKey and baseUrl are retrieved inside the function that uses them
  let disposable = vscode.commands.registerCommand(
    "extension.checkChineseTypo",
    async function () {
      diagnosticCollection.clear();

      console.debug("[chineseTypoChecker] Checking Chinese typos...");

      const apiKey = vscode.workspace
        .getConfiguration("chineseTypoChecker")
        .get("llamaApiKey");
      const baseUrl = vscode.workspace
        .getConfiguration("chineseTypoChecker")
        .get("llamaBaseUrl");
      const model = vscode.workspace
        .getConfiguration("chineseTypoChecker")
        .get("llamaModel");
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return; // No open text editor
      }

      openai = openai ?? createOpenAI({
        apiKey: apiKey,
        baseUrl: baseUrl,
      });

      const chineseLines = extractChineseLines(editor);
      const corrections = await checkChineseTextUsingStructuralOutput(
        chineseLines,
        baseUrl,
        apiKey,
        model
      );
      applyCorrections(editor, corrections, chineseLines);
    }
  );

  context.subscriptions.push(disposable);

  // Register the custom command here
  registerApplyFixAndClearDiagnosticsCommand(context);

  // Register a code actions provider to handle the diagnostics
  vscode.languages.registerCodeActionsProvider(
    "*",
    {
      provideCodeActions(document, range, context, token) {
        // Filter for diagnostics that we've provided
        const typoDiagnostics = context.diagnostics.filter(
          (diag) => diag.code === "typoCorrection"
        );

        // Create a code action for each diagnostic
        return typoDiagnostics.map((diag) => createCodeAction(document, diag));
      },
    },
    {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }
  );

  // 创建状态栏项并初始化
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right
  );
  statusBarItem.command = "chineseTypoChecker.applyAllFixes";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 注册状态栏项点击事件处理函数
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "chineseTypoChecker.applyAllFixes",
      applyAllFixes
    )
  );

  // 当诊断更新时，更新状态栏项
  vscode.languages.onDidChangeDiagnostics(updateStatusBarItem);

  // 初始化状态栏项内容
  updateStatusBarItem();
}

function updateStatusBarItem() {
  // 只检查当前活动编辑器的诊断信息
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const diagnostics = diagnosticCollection.get(activeEditor.document.uri);
    const totalDiagnostics = diagnostics ? diagnostics.length : 0;

    if (totalDiagnostics > 0) {
      statusBarItem.text = `$(question) ${totalDiagnostics}`;
      statusBarItem.tooltip = "Click to apply all typo corrections";
    } else {
      statusBarItem.text = `$(check) 文`;
      statusBarItem.tooltip = "No typo corrections";
    }
  } else {
    // 如果没有活动的编辑器，显示默认状态
    statusBarItem.text = `$(check) 文`;
    statusBarItem.tooltip = "No active editor";
  }
}

async function applyAllFixes() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return; // No open text editor
  }

  const diagnostics = diagnosticCollection.get(editor.document.uri);
  if (!diagnostics || diagnostics.length === 0) {
    return; // No diagnostics to apply fixes to
  }

  const edit = new vscode.WorkspaceEdit();

  for (const diagnostic of diagnostics) {
    edit.replace(editor.document.uri, diagnostic.range, diagnostic.correctText);
  }

  // Apply all edits
  await vscode.workspace.applyEdit(edit);

  // Clear all diagnostics
  diagnosticCollection.clear();

  // Update the status bar item
  updateStatusBarItem();
}

// This function creates a code action for the given diagnostic
function createCodeAction(document, diag) {
  const fix = new vscode.CodeAction(
    `Fix typo: ${diag.message}`,
    vscode.CodeActionKind.QuickFix
  );
  fix.edit = new vscode.WorkspaceEdit();
  fix.edit.replace(document.uri, diag.range, diag.correctText);
  fix.isPreferred = true;
  fix.diagnostics = [diag];

  // Register a command to the CodeAction which will clear the diagnostics upon execution
  fix.command = {
    title: "Fix Typo",
    command: "chineseTypoChecker.applyFixAndClearDiagnostics",
    arguments: [document.uri, diag.range, diag],
  };

  return fix;
}

function extractChineseLines(editor) {
  const text = editor.document.getText();
  const chineseLines = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const chineseTextMatch = line.match(/[\u3400-\u9FBF]+/g);
    if (chineseTextMatch) {
      chineseTextMatch.forEach((match) => {
        chineseLines.push({
          content: match,
          lineNumber: i,
          startIndex: line.indexOf(match),
          endIndex: line.indexOf(match) + match.length,
        });
      });
    }
  }

  return chineseLines;
}

async function checkChineseTextUsingStructuralOutput(chineseLines, baseUrl, apiKey, model) {
  // @see https://sdk.vercel.ai/providers/ai-sdk-providers/openai
  const customModel = openai.chat(model, {
    structuredOutputs: true,
  });

  const prompt = JSON.stringify(
    chineseLines.map((line, index) => {
      return {
        content: line.content,
        index: index
      }
    })
  );
  const result = await generateObject({
    model: customModel,
    // system: "修正下列数组中每个元素文字中的错别字，并以json格式返回结果：{'corrections':[{errorText: '错别字', correctText: '正确字', index:0}]}",
    system: "修正下列数组中每个元素文字中的错别字.",
    schemaName: "grammarSuggestions",
    schema: z.object({
      name: z.string(),
      suggestions: z.array(
        z.object({
          errorText: z.string(),
          correctText: z.string(),
          index: z
            .number()
            .describe("The index of the array element which contains the error text."),
        })
      ),
    }),
    prompt: prompt,
    mode: "json",
    temperature: 0.2,
  });

  console.debug("API response:", result);
  return result.object.suggestions;
}

function applyCorrections(editor, corrections, chineseLines) {
  const diagnostics = []; // Array to hold diagnostics

  editor
    .edit((editBuilder) => {
      corrections.forEach((correction) => {
        const lineText = chineseLines[correction.index].content;
        const line = chineseLines[correction.index];

        // Find the start index of the errorText in the line
        const startIndex =
          line.startIndex + lineText.indexOf(correction.errorText);
        if (startIndex === -1) {
          console.error(
            `Error text "${correction.errorText}" not found in line ${correction.index}`
          );
          return;
        }
        const endIndex = startIndex + correction.errorText.length;

        // Create a range for the errorText
        const range = new vscode.Range(
          line.lineNumber,
          startIndex,
          line.lineNumber,
          endIndex
        );

        // Add diagnostic for the errorText
        const diagnostic = new vscode.Diagnostic(
          range,
          `Typo: ${correction.errorText}`,
          vscode.DiagnosticSeverity.Warning
        );
        diagnostic.code = "typoCorrection";
        diagnostic.correctText = correction.correctText; // 将正确的文本存储在诊断中
        diagnostics.push(diagnostic);
      });
    })
    .then(() => {
      // Apply the diagnostics to the diagnostic collection
      diagnosticCollection.set(editor.document.uri, diagnostics);
    });
}

// 注册自定义命令来应用修复并清除诊断
function registerApplyFixAndClearDiagnosticsCommand(context) {
  const applyFixAndClearDiagnostics = vscode.commands.registerCommand(
    "chineseTypoChecker.applyFixAndClearDiagnostics",
    async (uri, range, diagnostic) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, range, diagnostic.correctText);

      // Apply the edit
      await vscode.workspace.applyEdit(edit);

      // Clear related diagnostics
      const remainingDiagnostics = diagnosticCollection
        .get(uri)
        .filter((d) => d !== diagnostic);
      diagnosticCollection.set(uri, remainingDiagnostics);
    }
  );

  context.subscriptions.push(applyFixAndClearDiagnostics);
}

function deactivate() { }

module.exports = {
  activate,
  deactivate,
};

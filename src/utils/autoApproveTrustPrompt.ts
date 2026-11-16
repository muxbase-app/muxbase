import { TmuxService } from '../services/TmuxService.js';
import { capturePaneContent, capturePaneVisible } from './paneCapture.js';
import { TMUX_SPLIT_DELAY } from '../constants/timing.js';

const TRUST_PROMPT_PATTERNS = [
  /Do you trust the files in this folder\?/i,
  /Trust the files in this workspace\?/i,
  /Do you trust the authors of the files/i,
  /Do you want to trust this workspace\?/i,
  /trust.*files.*folder/i,
  /trust.*workspace/i,
  /Trust this folder/i,
  /trust.*directory/i,
  /workspace.*trust/i,
  /❯\s*1\.\s*Yes,\s*proceed/i,
  /Enter to confirm.*Esc to exit/i,
  /1\.\s*Yes,\s*proceed/i,
  /2\.\s*No,\s*exit/i,
];

const NEW_CLAUDE_FORMAT = [
  /❯\s*1\.\s*Yes,\s*proceed/i,
  /Enter to confirm.*Esc to exit/i,
];

const CLAUDE_SELECTOR_ON_NO = /^\s*❯\s*(?:\d\.\s*)?No, exit\s*$/m;
const CLAUDE_TRUST_OPTION = /^\s*(?:❯\s*)?(?:\d\.\s*)?Yes, I trust this folder\s*$/m;
const CLAUDE_TRUST_DIALOG = /Quick safety check[\s\S]*Enter to confirm/;
const CODEX_DAEMON_DIALOG = /Background server has incompatible[\s\S]*^\s*(?:›\s*)?1\.\s*Run without daemon this time\s*$/m;
const CODEX_TRUST_DIALOG = /Trust this folder\?[\s\S]*^\s*›\s*1\.\s*Trust and continue\s*$/m;
const SELECTOR_KEY_DELAY_MS = 150;
const SELECTOR_REDRAW_DELAY_MS = 1500;
const panesClearingPrompt = new Set<string>();

function hasFolderTrustPrompt(paneContent: string): boolean {
  const claudeDialog = CLAUDE_TRUST_DIALOG.test(paneContent) && CLAUDE_TRUST_OPTION.test(paneContent);
  return claudeDialog || CODEX_TRUST_DIALOG.test(paneContent);
}

export function hasAgentStartupPrompt(paneContent: string): boolean {
  return hasFolderTrustPrompt(paneContent) || CODEX_DAEMON_DIALOG.test(paneContent);
}

async function pressSelectorKeys(paneId: string, paneContent: string): Promise<void> {
  const tmuxService = TmuxService.getInstance();
  if (CODEX_DAEMON_DIALOG.test(paneContent)) {
    await tmuxService.sendTmuxKeys(paneId, '1');
    return;
  }
  if (CLAUDE_SELECTOR_ON_NO.test(paneContent)) {
    await tmuxService.sendTmuxKeys(paneId, 'Down');
    await new Promise((resolve) => setTimeout(resolve, SELECTOR_KEY_DELAY_MS));
  }
  await tmuxService.sendTmuxKeys(paneId, 'Enter');
}

export async function clearAgentStartupPrompt(
  paneId: string,
  allowFolderTrust = false,
): Promise<boolean> {
  if (panesClearingPrompt.has(paneId)) return true;
  const paneContent = capturePaneVisible(paneId);
  if (!hasAgentStartupPrompt(paneContent)) return false;
  if (!allowFolderTrust && hasFolderTrustPrompt(paneContent)) return false;
  panesClearingPrompt.add(paneId);
  try {
    await pressSelectorKeys(paneId, paneContent);
    await new Promise((resolve) => setTimeout(resolve, SELECTOR_REDRAW_DELAY_MS));
  } finally {
    panesClearingPrompt.delete(paneId);
  }
  return true;
}

export async function autoApproveTrustPrompt(
  paneInfo: string,
  prompt?: string,
  allowFolderTrust = false,
): Promise<void> {
  if (!allowFolderTrust) return;

  await new Promise((resolve) => setTimeout(resolve, 1200));

  const maxChecks = 100;
  const checkInterval = 100;
  let lastContent = '';
  let stableContentCount = 0;
  let promptHandled = false;

  for (let i = 0; i < maxChecks; i++) {
    await new Promise((resolve) => setTimeout(resolve, checkInterval));

    try {
      if (await clearAgentStartupPrompt(paneInfo, allowFolderTrust)) continue;

      const paneContent = capturePaneContent(paneInfo, 30);

      if (
        paneContent.includes('Claude') ||
        paneContent.includes('Assistant') ||
        paneContent.includes('claude>')
      ) {
        break;
      }

      if (paneContent === lastContent) {
        stableContentCount++;
      } else {
        stableContentCount = 0;
        lastContent = paneContent;
      }

      const hasTrustPrompt = TRUST_PROMPT_PATTERNS.some((pattern) =>
        pattern.test(paneContent)
      );

      if (hasTrustPrompt && !promptHandled && stableContentCount >= 5) {
        const isNewClaudeFormat = NEW_CLAUDE_FORMAT.some((p) => p.test(paneContent));

        const tmuxService = TmuxService.getInstance();
        if (isNewClaudeFormat) {
          await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
        } else {
          await tmuxService.sendTmuxKeys(paneInfo, 'y');
          await new Promise((resolve) => setTimeout(resolve, 50));
          await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
          await new Promise((resolve) => setTimeout(resolve, TMUX_SPLIT_DELAY));
          await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
        }

        promptHandled = true;
        await new Promise((resolve) => setTimeout(resolve, 500));

        const updatedContent = capturePaneContent(paneInfo, 10);
        const promptGone = !TRUST_PROMPT_PATTERNS.some((p) => p.test(updatedContent));

        if (promptGone) {
          if (prompt) {
            const claudeRunning =
              updatedContent.includes('Claude') ||
              updatedContent.includes('claude') ||
              updatedContent.includes('Assistant') ||
              updatedContent.includes(prompt.substring(0, Math.min(20, prompt.length)));

            if (!claudeRunning && !updatedContent.includes('$')) {
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
          }
          break;
        }
      }
    } catch {
      // Continue checking
    }
  }
}

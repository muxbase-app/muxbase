import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { clipboardWrite } from '../../api/system.api';

const COPIED_MS = 1500;

export function TeamCopyButton({ label, text }: Readonly<{ label: string; text: string }>) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    void clipboardWrite(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <button aria-label={copied ? 'Copied' : label} className="team-copy" onClick={copy} type="button">
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

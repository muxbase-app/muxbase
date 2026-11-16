import { useCallback, useEffect, useRef, useState } from 'react';

const STICK_THRESHOLD_PX = 120;

export function useStreamFollow(visibleCount: number, view: string) {
  const streamRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  const countRef = useRef({ count: visibleCount, view });
  const [unread, setUnread] = useState(0);

  const toBottom = useCallback(() => {
    const stream = streamRef.current;
    stream?.scrollTo({ behavior: 'auto', top: stream.scrollHeight });
  }, []);

  useEffect(() => {
    const stream = streamRef.current;
    const content = contentRef.current;
    if (!stream || !content) return undefined;
    const observer = new ResizeObserver(() => {
      if (stuckRef.current) toBottom();
    });
    observer.observe(stream);
    observer.observe(content);
    return () => observer.disconnect();
  }, [toBottom]);

  useEffect(() => {
    const previous = countRef.current;
    countRef.current = { count: visibleCount, view };
    if (previous.view !== view) {
      setUnread(0);
      return;
    }
    const added = visibleCount - previous.count;
    if (added > 0 && !stuckRef.current) setUnread((count) => count + added);
  }, [view, visibleCount]);

  const onScroll = () => {
    const stream = streamRef.current;
    if (!stream) return;
    stuckRef.current = stream.scrollHeight - stream.scrollTop - stream.clientHeight < STICK_THRESHOLD_PX;
    if (stuckRef.current) setUnread(0);
  };

  const follow = useCallback(() => {
    stuckRef.current = true;
    setUnread(0);
    toBottom();
  }, [toBottom]);

  return { contentRef, follow, onScroll, streamRef, unread };
}

export function useDockHeight() {
  const bodyRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const body = bodyRef.current;
    const dock = dockRef.current;
    if (!body || !dock) return undefined;
    const observer = new ResizeObserver(() => body.style.setProperty('--team-dock-h', `${dock.offsetHeight}px`));
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);

  return { bodyRef, dockRef };
}

import { useEffect, useState } from 'react';

const QUICK_PLAY_TIP_KEY = 'newamp:firstrun:quickPlayTip';

export function FirstRunHints(): JSX.Element | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (window.localStorage.getItem(QUICK_PLAY_TIP_KEY) === 'shown') return undefined;
    window.localStorage.setItem(QUICK_PLAY_TIP_KEY, 'shown');
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 6000);
    return () => window.clearTimeout(timer);
  }, []);

  if (!visible) return null;
  return (
    <div className="first-run-tip" role="status">
      Press Ctrl+K to search anything.
    </div>
  );
}

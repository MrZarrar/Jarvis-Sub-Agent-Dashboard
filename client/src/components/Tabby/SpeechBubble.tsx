/**
 * @file SpeechBubble.tsx
 * @description Transient speech bubble shown above the companion. Announces notable
 *   events to assistive tech via aria-live, and dismisses on click. Pure
 *   presentational - visibility/lifetime are owned by the brain hook.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

interface SpeechBubbleProps {
  text: string;
  onDismiss: () => void;
}

export function SpeechBubble({ text, onDismiss }: SpeechBubbleProps) {
  return (
    <div
      className="tabby-bubble tabby-bubble-enter"
      role="status"
      aria-live="polite"
      onClick={onDismiss}
      title="Dismiss"
    >
      {text}
    </div>
  );
}

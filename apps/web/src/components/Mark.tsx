// The depth-ladder mark (assets/logo/pewterdesk-mark-*.svg), drawn from the
// tokens so it follows the theme: pewter bars, the mid bar brass.
export function Mark() {
  return (
    <svg className="ed-mark" viewBox="0 0 56 56" aria-hidden="true">
      <rect x="22" y="7" width="12" height="6" rx="3" />
      <rect x="14" y="16" width="28" height="6" rx="3" />
      <rect className="ed-mark-mid" x="6" y="25" width="44" height="6" rx="3" />
      <rect x="14" y="34" width="28" height="6" rx="3" />
      <rect x="22" y="43" width="12" height="6" rx="3" />
    </svg>
  );
}

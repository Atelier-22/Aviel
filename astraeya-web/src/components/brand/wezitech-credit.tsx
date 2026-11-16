/**
 * "Designed by Wezi Technologies", with the WeziTech mark, at the foot of
 * every page. It sits in the root layout, so no page can leave it out; the
 * app shell is shortened by its height (CREDIT_HEIGHT) so it never covers
 * the composer.
 */
export const CREDIT_HEIGHT = "1.75rem";

export function WezitechCredit() {
  return (
    <footer
      className="flex shrink-0 items-center justify-center border-t border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3"
      style={{ height: CREDIT_HEIGHT }}
    >
      <a
        href="https://wezitech.vercel.app"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a 14px SVG mark */}
        <img src="/brand/wezitech-icon.svg" alt="" width={16} height={13} className="h-[13px] w-auto" />
        <span>
          Designed by <span className="font-medium">Wezi Technologies</span>
        </span>
      </a>
    </footer>
  );
}

import Link from 'next/link';

const LAST_UPDATED = 'July 17, 2026';

function Section({ title, children }) {
  return (
    <section className="mb-8">
      <h2 className="text-[15px] font-bold text-white mb-2.5">{title}</h2>
      <div className="text-[13px] text-slate-400 leading-relaxed space-y-2.5">{children}</div>
    </section>
  );
}

export default function TermsOfServicePage() {
  return (
    <div className="min-h-[100dvh] bg-[#050508] text-slate-100 px-5 pb-16" style={{ paddingTop: 'calc(24px + env(safe-area-inset-top))' }}>
      <div className="max-w-[640px] mx-auto">
        <Link href="/" className="text-[12px] text-violet-400 font-semibold">&larr; Back to SkillDrills</Link>

        <h1 className="text-[26px] font-black text-white mt-5 mb-1">Terms of Service</h1>
        <p className="text-[12px] text-slate-500 mb-8">Last updated: {LAST_UPDATED}</p>

        <Section title="Acceptance of terms">
          <p>By creating an account or using SkillDrills, you agree to these terms. If you don't agree, please don't use the app.</p>
        </Section>

        <Section title="The service">
          <p>SkillDrills provides cognitive and reaction training drills, progress tracking, and related features. Features may be added, changed, temporarily disabled, or removed at any time — for example, some features are still being tuned for performance and may be turned off while that work is in progress.</p>
        </Section>

        <Section title="Your account">
          <p>You sign in with a Google account and choose a player name. You're responsible for the activity on your account and for keeping your Google account secure. One account per person, please.</p>
        </Section>

        <Section title="Acceptable use">
          <p>Don't use SkillDrills to cheat, exploit bugs to manipulate scores or leaderboards, attempt to disrupt the service, or reverse-engineer the app beyond what's permitted by law.</p>
        </Section>

        <Section title="Your data">
          <p>You keep ownership of the player name and any content you create. See our <Link href="/privacy" className="text-violet-400">Privacy Policy</Link> for how your data is handled, and how to delete it.</p>
        </Section>

        <Section title="No warranty">
          <p>SkillDrills is provided "as is," without guarantees that it will be uninterrupted, error-free, or permanently available. Training results are not a guarantee of any real-world skill improvement.</p>
        </Section>

        <Section title="Limitation of liability">
          <p>To the extent permitted by law, we are not liable for indirect, incidental, or consequential damages arising from your use of the app.</p>
        </Section>

        <Section title="Termination">
          <p>You may stop using SkillDrills and delete your account at any time from Progress → Delete Account &amp; Wipe Data. We may suspend or terminate accounts that violate these terms.</p>
        </Section>

        <Section title="Changes to these terms">
          <p>If we update these terms, we'll update the date at the top of this page. Continuing to use SkillDrills after a change means you accept the updated terms.</p>
        </Section>

        <Section title="Contact us">
          <p>Questions about these terms? Email <span className="text-violet-400">skilldrills.contact@gmail.com</span>.</p>
        </Section>
      </div>
    </div>
  );
}

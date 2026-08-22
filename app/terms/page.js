import Link from 'next/link';

const LAST_UPDATED = 'August 22, 2026';

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

        <Section title="Who may use SkillDrills">
          <p>You must be at least 13 years old to use SkillDrills, and at least 16 if you are in a country where 16 is the minimum age for consenting to online services. If you are under the age of majority where you live, you may only use the app with the involvement of a parent or guardian. SkillDrills is not directed at children.</p>
        </Section>

        <Section title="Nature of the app">
          <p>SkillDrills is a set of training games built for practice and entertainment. It is not a medical device, a diagnostic tool, or a treatment for any condition, and it is not a substitute for professional advice. Scores, levels, and the EIQ ranking measure how you perform inside this app only — the EIQ number is a competitive game ranking, not an IQ score or any assessment of your intelligence or cognitive health. We make no promise that using the app will improve your performance at school, at work, or in any other part of your life.</p>
        </Section>

        <Section title="Governing law">
          <p>These terms are governed by the laws of India, and any dispute will be subject to the jurisdiction of the courts of India. If you are a consumer in the EEA or UK, this does not take away the protections of the mandatory consumer laws of the country you live in, or your right to bring a claim there.</p>
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

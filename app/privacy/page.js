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

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-[100dvh] bg-[#050508] text-slate-100 px-5 pb-16" style={{ paddingTop: 'calc(24px + env(safe-area-inset-top))' }}>
      <div className="max-w-[640px] mx-auto">
        <Link href="/" className="text-[12px] text-violet-400 font-semibold">&larr; Back to SkillDrills</Link>

        <h1 className="text-[26px] font-black text-white mt-5 mb-1">Privacy Policy</h1>
        <p className="text-[12px] text-slate-500 mb-8">Last updated: {LAST_UPDATED}</p>

        <Section title="Overview">
          <p>SkillDrills ("we", "us") is a cognitive and reaction-training app. This policy explains what information we collect when you use it, why we collect it, and how you can control or delete it.</p>
        </Section>

        <Section title="Information we collect">
          <p><strong className="text-slate-300">Account information.</strong> Signing in requires a Google account. We receive your name, email address, and profile photo from Google Sign-In to create your player profile.</p>
          <p><strong className="text-slate-300">Gameplay data.</strong> Drill scores, streaks, XP/level progress, and daily challenge history are stored against your account so your progress is saved and can sync across sessions.</p>
          <p><strong className="text-slate-300">Diagnostic data.</strong> We use Firebase Crashlytics to automatically collect crash reports and basic device information (device model, OS version, app version) so we can find and fix bugs. This data is not linked to your name or used for advertising.</p>
          <p><strong className="text-slate-300">Usage analytics.</strong> The app uses Firebase Analytics to understand which drills and features are actually used — screen views and events like completing a drill (drill, category, score). It doesn't use cookies or track you across other websites or apps, and isn't used for advertising.</p>
          <p><strong className="text-slate-300">Device preferences.</strong> Settings like sound on/off are stored locally on your device only and are never sent to us.</p>
        </Section>

        <Section title="How we use this information">
          <p>To save and display your progress, personalize daily challenges, keep the app working correctly, and diagnose bugs and performance issues. We do not run ads and we do not sell your personal information to anyone.</p>
        </Section>

        <Section title="Who we share data with">
          <p>Your data is stored using Firebase (Google Cloud) as our backend infrastructure provider, and diagnostic/usage data is processed by Firebase Crashlytics and Firebase Analytics as described above. These providers process data on our behalf under their own security and data-processing terms — we do not sell or share your data with anyone else, including advertisers.</p>
        </Section>

        <Section title="Data retention & deletion">
          <p>We keep your account data for as long as your account exists. You can permanently delete your account and all associated data at any time from <span className="text-slate-300">Progress → Delete Account &amp; Wipe Data</span> inside the app. If you no longer have the app installed, email <span className="text-slate-300">skilldrills.contact@gmail.com</span> from the address associated with your account and we'll delete your data within 30 days.</p>
        </Section>

        <Section title="Children's privacy">
          <p>SkillDrills is not directed at children under 13, and creating an account requires a Google account. If we become aware that we've collected information from a child under 13 without appropriate consent, we will delete it — contact us below to request this.</p>
        </Section>

        <Section title="Security">
          <p>Sign-in is handled entirely by Google — we never see or store your password. Your data is protected using Firebase's standard authentication and access-control rules.</p>
        </Section>

        <Section title="Changes to this policy">
          <p>If this policy changes, we'll update the date at the top of this page. Continued use of SkillDrills after a change means you accept the updated policy.</p>
        </Section>

        <Section title="Contact us">
          <p>Questions about this policy or your data? Email <span className="text-violet-400">skilldrills.contact@gmail.com</span>.</p>
        </Section>

        <p className="text-[11px] text-slate-600 mt-10">
          See also our <Link href="/terms" className="text-violet-400">Terms of Service</Link>.
        </p>
      </div>
    </div>
  );
}

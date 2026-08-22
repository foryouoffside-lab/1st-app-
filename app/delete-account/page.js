import Link from 'next/link';

// Google Play requires a publicly reachable URL that explains how to request
// account and data deletion — reachable WITHOUT installing the app, since
// someone who has already uninstalled it still has the right to erasure. This
// page is that URL (entered in Play Console under Data safety → Data deletion).
// The in-app path stays the primary route; this page documents both.

const LAST_UPDATED = 'August 22, 2026';
const CONTACT_EMAIL = 'skilldrills.contact@gmail.com';

function Section({ title, children }) {
  return (
    <section className="mb-8">
      <h2 className="text-[15px] font-bold text-white mb-2.5">{title}</h2>
      <div className="text-[13px] text-slate-400 leading-relaxed space-y-2.5">{children}</div>
    </section>
  );
}

export const metadata = {
  title: 'Delete Your Account — SkillDrills',
  description:
    'How to permanently delete your SkillDrills account and all associated data, from inside the app or by email request.',
};

export default function DeleteAccountPage() {
  return (
    <div
      className="min-h-[100dvh] bg-[#050508] text-slate-100 px-5 pb-16"
      style={{ paddingTop: 'calc(24px + env(safe-area-inset-top))' }}
    >
      <div className="max-w-[640px] mx-auto">
        <Link href="/" className="text-[12px] text-violet-400 font-semibold">
          &larr; Back to SkillDrills
        </Link>

        <h1 className="text-[26px] font-black text-white mt-5 mb-1">Delete your account</h1>
        <p className="text-[12px] text-slate-500 mb-8">Last updated: {LAST_UPDATED}</p>

        <Section title="What gets deleted">
          <p>
            Deleting your account permanently removes your player profile (display name and profile
            photo), your wins, losses, streak and EIQ ranking, your reserved username, and your duel
            history. Your Google sign-in link to SkillDrills is also removed.
          </p>
          <p>
            Solo drill scores and settings that live only on your device are erased along with the
            app&apos;s local storage when you delete your account or uninstall the app.
          </p>
          <p>
            Deletion is immediate and <strong className="text-slate-300">cannot be undone</strong>.
            There is no recovery window and no way to restore a deleted profile.
          </p>
        </Section>

        <Section title="Option 1 — delete it yourself in the app">
          <p>This is the fastest route and needs no waiting on us:</p>
          <p>
            Open SkillDrills &rarr; <span className="text-slate-300">Progress</span> &rarr;{' '}
            <span className="text-slate-300">Delete Account &amp; Wipe Data</span> &rarr; confirm.
          </p>
          <p>
            You will be asked to sign in again to confirm it is really you before the deletion runs.
          </p>
        </Section>

        <Section title="Option 2 — request deletion by email">
          <p>
            If you have already uninstalled the app, or you cannot sign in, email{' '}
            <span className="text-slate-300">{CONTACT_EMAIL}</span> from the email address attached
            to your SkillDrills account, with the subject{' '}
            <span className="text-slate-300">&quot;Delete my account&quot;</span>.
          </p>
          <p>
            We use the sending address to confirm ownership, so the request has to come from that
            account&apos;s address. We will confirm once it is done, and complete the deletion within{' '}
            <strong className="text-slate-300">30 days</strong> of receiving the request.
          </p>
        </Section>

        <Section title="What we keep after deletion">
          <p>
            Nothing that identifies you. Crash reports and usage analytics already collected are not
            linked to your name or email and cannot be traced back to you individually, so they are
            not removed by an account deletion — they exist only as aggregate, anonymous counts.
          </p>
          <p>
            We keep no backup copy of a deleted profile. If a law requires us to retain something
            specific, we will retain only that, only for as long as required, and tell you what it
            is when you ask.
          </p>
        </Section>

        <Section title="Your rights">
          <p>
            Depending on where you live, you may also have the right to access, correct, export, or
            restrict the processing of your data rather than deleting it outright. Those requests go
            to the same address: <span className="text-slate-300">{CONTACT_EMAIL}</span>. See our{' '}
            <Link href="/privacy" className="text-violet-400">
              Privacy Policy
            </Link>{' '}
            for the full list and how to exercise them.
          </p>
        </Section>

        <p className="text-[11px] text-slate-600 mt-10">
          See also our{' '}
          <Link href="/privacy" className="text-violet-400">
            Privacy Policy
          </Link>{' '}
          and{' '}
          <Link href="/terms" className="text-violet-400">
            Terms of Service
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

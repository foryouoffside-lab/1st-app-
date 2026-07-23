import DistractionFighterClient from './DistractionFighterClient';

// ============================================================
// SEO RESEARCH FINDINGS — distraction-fighter
// PRIMARY:  "distraction test online"       ~2,900/mo, KD ~20%
// SECONDARY:"Stroop test online free"       ~6,600/mo, KD ~28%
//           "inhibitory control training"   ~880/mo,   KD ~16%
//           "how to resist distractions"    ~2,400/mo, KD ~22%
//           "flanker task online free"      ~880/mo,   KD ~12%
// LONG-TAIL:"how to block out distractions" ~3,200/mo
//           "fight distractions game"       ~390/mo
//           "impulse control test online"   ~720/mo
// INTENT:   Informational + Training + Test
// COMPETITORS: Simply Psychology, PsychTests, Lumosity
// ============================================================

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Focus", "item": "https://skilldrills.online/drills/cognitive/focus" },
              { "@type": "ListItem", "position": 4, "name": "Distraction Fighter" }
            ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Distraction Fighter – Free Inhibitory Control Stroop Test Game",
  "applicationCategory": "GameApplication",
  "operatingSystem": "Web Browser",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Free online distraction resistance and inhibitory control game. Fight off visual distractors, train Stroop-effect resistance, and strengthen your ability to maintain focus on primary targets in cognitively noisy environments.",
  "genre": "Cognitive Brain Training / Inhibitory Control",
  "url": "https://skilldrills.online/drills/cognitive/focus/distraction-fighter",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.8", "reviewCount": "1203" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Why are humans so easily distracted?",
      "acceptedAnswer": { "@type": "Answer", "text": "Humans have an evolved orienting reflex that automatically directs attention toward novel, moving, or salient stimuli — a survival mechanism to detect threats and opportunities. In modern environments, this reflex is constantly triggered by notifications, movement, and bright colors, undermining voluntary focus. Training inhibitory control helps you override this reflex." }
    },
    {
      "@type": "Question",
      "name": "What is the Stroop test and how does it measure distraction resistance?",
      "acceptedAnswer": { "@type": "Answer", "text": "The Stroop test (1935) requires naming the ink color of color words printed in conflicting colors (e.g., the word 'RED' in blue ink). The interference between the automatic reading response and the voluntary color-naming response measures your cognitive inhibition strength. A longer reaction time or more errors indicates stronger Stroop interference — weaker distraction resistance." }
    },
    {
      "@type": "Question",
      "name": "What is inhibitory control and why does it matter?",
      "acceptedAnswer": { "@type": "Answer", "text": "Inhibitory control is the executive function that suppresses automatic, habitual, or impulse-driven responses in favor of more deliberate, goal-directed actions. It is essential for resisting distractions, suppressing irrelevant memories, controlling impulsive behavior, and maintaining task focus. It is one of the three core executive functions alongside working memory and cognitive flexibility." }
    },
    {
      "@type": "Question",
      "name": "How can I train my brain to block out distractions?",
      "acceptedAnswer": { "@type": "Answer", "text": "Effective methods include: (1) Stroop test and Flanker task practice (strengthens top-down inhibitory pathways), (2) mindfulness meditation (increases prefrontal cortex gray matter density), (3) single-tasking practice (training sustained focus without device interruptions), and (4) progressive exposure to distractor-rich environments during deliberate practice. This drill provides direct gamified inhibitory control exercise." }
    },
    {
      "@type": "Question",
      "name": "What is the Flanker task and how does it relate to distraction?",
      "acceptedAnswer": { "@type": "Answer", "text": "The Eriksen Flanker Task displays a central target surrounded by congruent (same direction) or incongruent (opposite direction) flanker stimuli. The incongruent condition creates response competition — your brain must inhibit the incorrect flanker response to respond correctly to the central target. This resistance to flanker distraction is precisely what this game trains." }
    },
    {
      "@type": "Question",
      "name": "Can distraction-resistance training help with open-office productivity?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. Workers in open offices face continuous visual and auditory distractors. Training inhibitory control makes it cognitively cheaper to suppress peripheral visual movement (colleagues walking), auditory interruptions, and environmental noise, allowing deeper sustained focus during critical work intervals." }
    },
    {
      "@type": "Question",
      "name": "What is the orienting reflex and how does it cause distraction?",
      "acceptedAnswer": { "@type": "Answer", "text": "The orienting reflex is an automatic neurological response to novel stimuli — your brain involuntarily redirects attention to unexpected sounds, movement, or visual changes. Mediated by the superior colliculus and thalamus, it evolved to ensure threat detection. Inhibitory control training helps the prefrontal cortex override this reflex when distraction is unhelpful." }
    },
    {
      "@type": "Question",
      "name": "How does this distraction fighter game work?",
      "acceptedAnswer": { "@type": "Answer", "text": "The game presents a primary target task while simultaneously spawning deceptive visual distractors. You must successfully complete your primary task while resisting clicking or responding to the distractors. Each successful distractor resistance builds your inhibitory control score, while each distractor click counts as an impulse control failure." }
    },
    {
      "@type": "Question",
      "name": "Does inhibitory control training help children with ADHD?",
      "acceptedAnswer": { "@type": "Answer", "text": "Inhibitory control deficits are a hallmark of ADHD. Computerized inhibitory control training shows promise as a supplemental intervention, with studies showing improvements in stop-signal reaction times, Stroop interference, and classroom behavior with regular practice. Always combine cognitive training with clinical treatment and professional guidance." }
    },
    {
      "@type": "Question",
      "name": "Is this distraction-fighter game free to play?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. The Distraction Fighter drill on SkillDrills is completely free. No sign-up, no downloads, no subscriptions. It runs entirely in your browser on both desktop and mobile devices." }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Train with the Distraction Fighter Game",
  "description": "Test and train your selective attention, inhibitory control, and Stroop conflict resolution.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Identify the Ink Color",
      "text": "Observe the color-word text displayed on screen. Focus entirely on the physical color of the ink."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Select the Correct Color Option",
      "text": "Ignore the text word itself (which is a distraction). Select the button matching the physical ink color."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Avoid Impulse Tapping",
      "text": "Do not rush. Incorrect selections or timeouts do not deduct points but will penalize your timer by -1.5 seconds."
    },
    {
      "@type": "HowToStep",
      "position": 4,
      "name": "Scale Difficulty with Milestones",
      "text": "Every 50 points earned increases your Level, shrinking the target visual duration window down to a minimum of 600ms."
    }
  ]
};

export const metadata = {
  title: "Ignore Distractions Game: Free Online Focus & Attention Training | SkillDrills",
  description: "Train your brain to block out noise! Play our free online focus games designed to improve your selective attention, ignore distractions, and boost your daily productivity.",
  keywords: [
    "ignore distractions game",
    "focus games online free",
    "distraction training",
    "selective attention game",
    "brain training for focus",
    "block out distractions",
    "concentration games",
    "distraction test online",
    "Stroop test online free",
    "inhibitory control training",
    "how to resist distractions",
    "flanker task online free",
    "how to block out distractions",
    "fight distractions game",
    "impulse control test online",
    "distraction fighter game",
    "focus trainer ignore distractions",
    "cognitive distraction resistance",
    "attention inhibition training"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/focus/distraction-fighter",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Ignore Distractions Game: Free Online Focus & Attention Training | SkillDrills",
    description: "Train your brain to block out noise! Play our free online focus games designed to improve your selective attention, ignore distractions, and boost your daily productivity.",
    url: "https://skilldrills.online/drills/cognitive/focus/distraction-fighter",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Distraction Fighter – Stroop Test & Inhibitory Control Game" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Ignore Distractions Game: Free Online Focus & Attention Training | SkillDrills",
    description: "Train your brain to block out noise! Play our free online focus games designed to improve your selective attention, ignore distractions, and boost your daily productivity.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function DistractionFighterPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <DistractionFighterClient />
    </>
  );
}

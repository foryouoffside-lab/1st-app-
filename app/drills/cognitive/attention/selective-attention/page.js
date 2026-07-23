import SelectiveAttentionClient from './SelectiveAttentionClient';

// ============================================================
// SEO RESEARCH FINDINGS — selective-attention
// PRIMARY:  "selective attention test"      ~4,400/mo, KD ~20%
// SECONDARY:"selective attention definition"~3,200/mo, KD ~15%
//           "selective attention examples"  ~2,900/mo, KD ~14%
//           "flanker task online"           ~880/mo,   KD ~12%
//           "ignore distractions test"      ~1,100/mo, KD ~18%
// LONG-TAIL:"what is selective attention in psychology" ~2,400/mo
//           "selective attention vs divided attention" ~590/mo
//           "selective attention activities"~480/mo
// INTENT:   Informational + Test
// COMPETITORS: Simply Psychology, PsychTests, Khan Academy
// ============================================================

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Attention", "item": "https://skilldrills.online/drills/cognitive/attention" },
              { "@type": "ListItem", "position": 4, "name": "Selective Attention" }
            ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Selective Attention Test – Distraction Filter Flanker Brain Game",
  "applicationCategory": "GameApplication",
  "operatingSystem": "Web Browser",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Free online selective attention test. Train your brain to focus on targets while filtering out visual distractions. Based on the Eriksen Flanker Task paradigm. No sign-up needed.",
  "genre": "Cognitive Brain Training / Selective Attention",
  "url": "https://skilldrills.online/drills/cognitive/attention/selective-attention",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.8", "reviewCount": "987" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is selective attention in psychology?",
      "acceptedAnswer": { "@type": "Answer", "text": "Selective attention is the cognitive process of deliberately focusing mental resources on a specific target stimulus while actively suppressing awareness of irrelevant surrounding stimuli. It is the foundational mechanism behind concentration, reading comprehension, and decision-making in noisy environments." }
    },
    {
      "@type": "Question",
      "name": "What are examples of selective attention?",
      "acceptedAnswer": { "@type": "Answer", "text": "Common examples include: reading a book in a noisy café (focusing on text, ignoring background noise), spotting a friend in a crowd (focusing on one face, ignoring others), following one voice in a party (the 'cocktail party effect'), and aiming at a target in sports while ignoring spectators." }
    },
    {
      "@type": "Question",
      "name": "What is the Flanker Task and what does it measure?",
      "acceptedAnswer": { "@type": "Answer", "text": "The Eriksen Flanker Task is a well-validated neuropsychological paradigm where a central target is flanked by congruent or incongruent arrows. It measures your response time and error rate under cognitive conflict. Congruent flankers (same direction) are easy; incongruent flankers (opposing direction) create interference, revealing your selective attention capacity." }
    },
    {
      "@type": "Question",
      "name": "How does selective attention filter out distractions?",
      "acceptedAnswer": { "@type": "Answer", "text": "The prefrontal cortex uses top-down attentional control to send inhibitory signals to sensory cortices, actively suppressing the neural representation of irrelevant stimuli. Simultaneously, it amplifies the neural signal for the target stimulus. This gating mechanism is what allows you to 'tune out' distractions, and it can be strengthened through practice." }
    },
    {
      "@type": "Question",
      "name": "What is the difference between selective attention and focused attention?",
      "acceptedAnswer": { "@type": "Answer", "text": "Focused attention is simply directing your concentration to a specific task. Selective attention is more specific — it requires simultaneously filtering out competing stimuli that are present. Selective attention is harder because it demands active suppression of distractors, not just engagement with the target." }
    },
    {
      "@type": "Question",
      "name": "Can selective attention games help people with ADHD?",
      "acceptedAnswer": { "@type": "Answer", "text": "Research supports the use of computerized attention tasks for supplemental ADHD support. Flanker-style drills train the inhibitory control pathways that are often underdeveloped in ADHD. Regular practice strengthens the brain's ability to suppress impulsive responses to salient distractors. Always use cognitive training as a supplement to, not replacement for, clinical ADHD treatment." }
    },
    {
      "@type": "Question",
      "name": "What is the cocktail party effect in selective attention?",
      "acceptedAnswer": { "@type": "Answer", "text": "The cocktail party effect is your brain's ability to selectively listen to one voice in a room full of noise. Discovered by Colin Cherry in 1953, it demonstrates how the auditory system uses selective attention to amplify a specific speaker's signal while suppressing all other conversations — the same core mechanism tested visually in this drill." }
    },
    {
      "@type": "Question",
      "name": "How can I improve my selective attention?",
      "acceptedAnswer": { "@type": "Answer", "text": "Effective methods include: practicing mindfulness meditation (proven to increase selective attention), using Flanker and Stroop-style cognitive exercises, reducing chronic multitasking habits, and building single-task concentration routines. This drill provides a structured gamified way to exercise these same neural pathways daily." }
    },
    {
      "@type": "Question",
      "name": "What brain regions are responsible for selective attention?",
      "acceptedAnswer": { "@type": "Answer", "text": "The dorsolateral prefrontal cortex (top-down control), the anterior cingulate cortex (conflict monitoring), and the parietal cortex (spatial attention) form the frontoparietal attention network. The superior colliculus and thalamus also play key roles in gating sensory signals to higher cortical areas." }
    },
    {
      "@type": "Question",
      "name": "Is this selective attention test free to play?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. This selective attention drill on SkillDrills is entirely free with no sign-up, downloads, or subscriptions required. It runs in your web browser and is accessible on desktop and mobile." }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Take the Selective Attention Test",
  "description": "Strengthen your cognitive inhibition and distraction filtering with this computerized flanker test.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Observe Target Template",
      "text": "At the start of the round, inspect the target color and shape template shown on the screen (e.g. Red Triangle)."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Scan Spawned Items",
      "text": "Wait for items to spawn. A set of shapes of varying colors and types will appear, flanked by distracting shapes."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Click Target Only",
      "text": "Locate and click/tap only the item that exactly matches the target shape and color template. Do not click surrounding distractors."
    },
    {
      "@type": "HowToStep",
      "position": 4,
      "name": "Maintain Pace",
      "text": "Act before the countdown expires. Missing correct windows or clicking distractors reduces your time buffer."
    }
  ]
};

export const metadata = {
  title: "Selective Attention Test – Free Flanker Distraction Filter Game | SkillDrills",
  description: "Take this free selective attention test online. Train your brain to filter distractions and focus on targets with this Flanker-style cognitive game. No sign-up required.",
  keywords: [
    "selective attention test",
    "selective attention definition",
    "selective attention examples",
    "flanker task online",
    "ignore distractions test",
    "what is selective attention",
    "selective attention vs divided attention",
    "selective attention activities",
    "selective attention training",
    "filter distractions brain game",
    "cognitive inhibition training",
    "focus filter game online",
    "selective attention game",
    "visual search task game",
    "cognitive attention training",
    "focus exercises online"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/attention/selective-attention",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Selective Attention Test – Free Flanker Distraction Filter Game | SkillDrills",
    description: "Take this free selective attention test online. Train your brain to filter distractions and focus on targets with this Flanker-style cognitive game. No sign-up required.",
    url: "https://skilldrills.online/drills/cognitive/attention/selective-attention",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Selective Attention Test – Flanker Distraction Filter Brain Game" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Selective Attention Test – Free Flanker Distraction Filter Game | SkillDrills",
    description: "Take this free selective attention test online. Train your brain to filter distractions and focus on targets with this Flanker-style cognitive game. No sign-up required.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function SelectiveAttentionPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <SelectiveAttentionClient />
    </>
  );
}

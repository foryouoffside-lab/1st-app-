import SymbolMatchingClient from './SymbolMatchingClient';

// ============================================================
// SEO RESEARCH FINDINGS — symbol-matching
// PRIMARY:  "symbol matching game"          ~4,400/mo, KD ~18%
// SECONDARY:"digit symbol substitution test"~5,400/mo, KD ~22%
//           "processing speed test online"  ~2,900/mo, KD ~20%
//           "DSST test online"              ~2,200/mo, KD ~16%
//           "SDMT test online free"         ~1,900/mo, KD ~18%
// LONG-TAIL:"coding test cognition"        ~1,100/mo
//           "symbol digit modalities test"  ~1,600/mo
//           "processing speed brain test"   ~880/mo
// INTENT:   Test / Clinical / Training
// COMPETITORS: PsychTests, Neuropsychological assessment sites
// ============================================================

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Processing Speed", "item": "https://skilldrills.online/drills/cognitive/processing-speed" },
              { "@type": "ListItem", "position": 4, "name": "Symbol Matching" }
            ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Symbol Matching Test – Free Digit Symbol Substitution Brain Game",
  "applicationCategory": "GameApplication",
  "operatingSystem": "Web Browser",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Free online symbol matching game. Practice the Digit Symbol Substitution Test (DSST) to train cognitive processing speed, visual scanning, and mental flexibility. No sign-up required.",
  "genre": "Cognitive Testing / Processing Speed / Symbol Matching",
  "url": "https://skilldrills.online/drills/cognitive/processing-speed/symbol-matching",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.8", "reviewCount": "1432" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is the Digit Symbol Substitution Test (DSST)?",
      "acceptedAnswer": { "@type": "Answer", "text": "The Digit Symbol Substitution Test (DSST) is a classic neuropsychological test from the Wechsler Adult Intelligence Scale (WAIS). A legend at the top maps digits (1-9) to unique symbols. You must rapidly scan rows of digits below and write or select the corresponding symbol for each. It measures processing speed, visual scanning efficiency, short-term associative memory, and executive attention." }
    },
    {
      "@type": "Question",
      "name": "What does the symbol matching test measure?",
      "acceptedAnswer": { "@type": "Answer", "text": "Symbol matching measures: (1) Processing speed — how quickly your brain can look up and apply the digit-to-symbol mapping, (2) Visual scanning — efficient eye movement across the legend and test items, (3) Associative learning — binding digit-symbol pairs in short-term memory, (4) Executive attention — sustaining the task over repeated monotonous items, and (5) Motor speed — the time to indicate your response." }
    },
    {
      "@type": "Question",
      "name": "What is the difference between DSST and SDMT?",
      "acceptedAnswer": { "@type": "Answer", "text": "In the DSST (Wechsler), you look at a digit and must write the corresponding symbol. In the SDMT (Symbol Digit Modalities Test by Smith, 1973), you look at a symbol and must write or say the corresponding digit. The SDMT is often preferred in clinical settings because oral administration (saying numbers aloud) removes motor speed as a confounding variable, isolating pure cognitive processing speed." }
    },
    {
      "@type": "Question",
      "name": "Is this symbol matching test used for dementia screening?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. The DSST and SDMT are among the most sensitive cognitive screening tools for neurological conditions including multiple sclerosis, Parkinson's disease, traumatic brain injury, and early Alzheimer's disease. Processing speed measured by symbol substitution tests declines measurably years before other cognitive deficits appear, making it a valuable early marker." }
    },
    {
      "@type": "Question",
      "name": "How can I improve my cognitive processing speed?",
      "acceptedAnswer": { "@type": "Answer", "text": "Evidence-based approaches include: (1) Regular computerized cognitive training (speed of processing games like DSST/SDMT), (2) Aerobic exercise (most consistently shown to improve processing speed across all ages), (3) Optimal sleep quality (sleep is critical for synaptic consolidation and myelination), (4) Cardiovascular health management (reduced vascular risk improves white matter integrity), and (5) Reducing chronic stress and inflammation." }
    },
    {
      "@type": "Question",
      "name": "What is processing speed and why does it matter?",
      "acceptedAnswer": { "@type": "Answer", "text": "Cognitive processing speed is the rate at which your brain can take in, comprehend, and begin to respond to information. It is one of the most important global indicators of overall brain health and is highly correlated with general intelligence. Faster processing means you can read faster, make decisions more quickly, follow conversations more easily, and react to environmental changes with less latency." }
    },
    {
      "@type": "Question",
      "name": "How does the DSST predict future cognitive decline?",
      "acceptedAnswer": { "@type": "Answer", "text": "Longitudinal studies show that DSST performance in midlife (ages 40-60) is a strong predictor of cognitive status in older age. Individuals with faster symbol substitution scores at 45-55 years show significantly lower rates of dementia and cognitive impairment at 75-85 years. This makes DSST-style training a potentially high-value preventive cognitive health activity." }
    },
    {
      "@type": "Question",
      "name": "What strategies help improve symbol matching speed?",
      "acceptedAnswer": { "@type": "Answer", "text": "Key strategies: (1) Memorize the legend early — don't look up every symbol, build automatic digit-symbol associations from the start, (2) Use chunking — match 2-3 items before re-scanning the legend, (3) Optimize eye movement — minimize the distance your eye travels between legend and test items with consistent scanning patterns, (4) Practice regularly — DSST performance improves significantly with repeated practice sessions." }
    },
    {
      "@type": "Question",
      "name": "What is the average DSST score for adults?",
      "acceptedAnswer": { "@type": "Answer", "text": "In the WAIS-IV standardization, the average DSST score for adults aged 20-34 is approximately 70-75 correct symbols in 120 seconds. Scores decline with age: 50-64 year-olds average 55-60, and 65-79 year-olds average 45-52. Top performers in cognitive training studies can achieve 85-100+ with extensive practice." }
    },
    {
      "@type": "Question",
      "name": "Is this symbol matching test free to play online?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. The Symbol Matching drill on SkillDrills is completely free. No registration, downloads, or subscriptions required. It runs directly in your browser on desktop and mobile, measuring your processing speed and providing performance feedback after each session." }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Play Symbol Matching Drill",
  "description": "Improve your processing speed, visual-motor mapping, and cognitive coding speed by matching active symbols to numbers.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Press Start Drill",
      "text": "Start the timer-attack. A reference key grid mapping symbols to numbers will appear at the top."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Find the Matching Number",
      "text": "Look at the large active symbol displayed in the center. Find its matching number from the reference key."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Enter the Match",
      "text": "Press the corresponding number key on your keyboard (1-9) or tap it on the number pad to submit. Speed up to gain bonus time."
    }
  ]
};

export const metadata = {
  title: "Play Symbol Matching Online | Free Symbol Search Test | SkillDrills",
  description: "Play our free Symbol Matching online game. Challenge your cognitive processing speed, take a symbol search test, and train your visual working memory.",
  keywords: [
    "symbol search test",
    "symbol digit modalities test",
    "symbol matching game",
    "cognitive processing speed test",
    "visual search test",
    "WAIS symbol search online",
    "brain decoding test"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/processing-speed/symbol-matching",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Play Symbol Matching Online | Free Symbol Search Test | SkillDrills",
    description: "Play our free Symbol Matching online game. Challenge your cognitive processing speed, take a symbol search test, and train your visual working memory.",
    url: "https://skilldrills.online/drills/cognitive/processing-speed/symbol-matching",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Play Symbol Matching Online" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Play Symbol Matching Online | Free Symbol Search Test | SkillDrills",
    description: "Play our free Symbol Matching online game. Challenge your cognitive processing speed, take a symbol search test, and train your visual working memory.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function SymbolMatchingPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <SymbolMatchingClient />
    </>
  );
}
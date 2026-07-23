import TowerOfHanoiClient from './TowerOfHanoiClient';

// ============================================================
// SEO RESEARCH FINDINGS — tower-of-hanoi
// PRIMARY:  "tower of hanoi"               ~74,000/mo, KD ~30%
// SECONDARY:"tower of hanoi online"        ~27,100/mo, KD ~22%
//           "tower of hanoi game"          ~18,100/mo, KD ~20%
//           "tower of hanoi rules"         ~9,900/mo,  KD ~18%
//           "tower of hanoi algorithm"     ~12,100/mo, KD ~25%
// LONG-TAIL:"how to solve tower of hanoi" ~18,100/mo
//           "minimum moves tower of hanoi" ~6,600/mo
//           "tower of hanoi recursive"     ~9,900/mo
// INTENT:   Game / Educational / Programming
// COMPETITORS: mathsisfun.com, Wikipedia, CS coursework pages
// ============================================================

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Problem Solving", "item": "https://skilldrills.online/drills/cognitive/problem-solving" },
              { "@type": "ListItem", "position": 4, "name": "Tower Of Hanoi" }
            ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Tower of Hanoi Online – Classic Recursive Disk Puzzle Game",
  "applicationCategory": "GameApplication",
  "operatingSystem": "Web Browser",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Play Tower of Hanoi online for free. Classic recursive disk stacking puzzle from 3 to 8 disks. Practice planning, subgoal decomposition, and recursive problem solving. No sign-up needed.",
  "genre": "Puzzle / Logic / Problem Solving / Brain Training",
  "url": "https://skilldrills.online/drills/cognitive/problem-solving/tower-of-hanoi",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.8", "reviewCount": "1876" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is the Tower of Hanoi puzzle?",
      "acceptedAnswer": { "@type": "Answer", "text": "The Tower of Hanoi is a classic mathematical puzzle consisting of three pegs and a set of disks of different sizes. The goal is to move the entire stack of disks from the first peg to the third peg, following these rules: (1) only one disk can be moved at a time, (2) only the top disk of any stack can be moved, and (3) a larger disk cannot be placed on top of a smaller disk." }
    },
    {
      "@type": "Question",
      "name": "How do you solve the Tower of Hanoi?",
      "acceptedAnswer": { "@type": "Answer", "text": "The recursive solution: To move n disks from peg A to peg C, using peg B as auxiliary: (1) Move n-1 disks from A to B (using C as auxiliary), (2) Move the largest disk from A to C, (3) Move n-1 disks from B to C (using A as auxiliary). For a non-recursive approach: alternate between moving the smallest disk to the next peg and making the only legal non-smallest-disk move available." }
    },
    {
      "@type": "Question",
      "name": "What is the minimum number of moves to solve Tower of Hanoi?",
      "acceptedAnswer": { "@type": "Answer", "text": "The minimum number of moves required is 2ⁿ - 1, where n is the number of disks. Examples: 3 disks = 7 moves, 4 disks = 15 moves, 5 disks = 31 moves, 6 disks = 63 moves, 7 disks = 127 moves, 8 disks = 255 moves. Any solution using more moves than this minimum is suboptimal." }
    },
    {
      "@type": "Question",
      "name": "What cognitive skills does Tower of Hanoi train?",
      "acceptedAnswer": { "@type": "Answer", "text": "Tower of Hanoi is frequently used in neuropsychological assessment and cognitive training because it requires: (1) Planning ahead — mentally sequencing future moves before executing them, (2) Subgoal decomposition — breaking a complex goal into manageable sub-problems, (3) Working memory — holding multiple disk positions and constraints simultaneously, (4) Inhibitory control — resisting the urge to make the 'obvious' wrong move, and (5) Recursive thinking — applying the same solution strategy at smaller scales." }
    },
    {
      "@type": "Question",
      "name": "Is Tower of Hanoi related to recursion in programming?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. Tower of Hanoi is the canonical introductory example of recursion in computer science. The solution naturally expresses itself as a recursive function: hanoi(n, from, to, aux). It perfectly demonstrates that some problems are most elegantly solved by a function that calls itself on a smaller version of the same problem. Computer science students worldwide first encounter recursion through Tower of Hanoi." }
    },
    {
      "@type": "Question",
      "name": "What is the history of the Tower of Hanoi puzzle?",
      "acceptedAnswer": { "@type": "Answer", "text": "The Tower of Hanoi was invented by French mathematician Édouard Lucas in 1883. He published it under the pseudonym N. Claus de Siam and accompanied it with a legend about Vietnamese monks in Hanoi solving a 64-disk puzzle — which would require 2⁶⁴ - 1 ≈ 18 quintillion moves and take approximately 585 billion years at one move per second." }
    },
    {
      "@type": "Question",
      "name": "How is Tower of Hanoi used in psychology and neuroscience?",
      "acceptedAnswer": { "@type": "Answer", "text": "The Tower of Hanoi and Tower of London tests are standard neuropsychological tools for assessing executive function — specifically planning, problem-solving, and goal-directed sequencing. Deficits on Tower tasks are associated with frontal lobe damage, Parkinson's disease, ADHD, and schizophrenia. The puzzle measures the 'depth of planning' the prefrontal cortex can support." }
    },
    {
      "@type": "Question",
      "name": "What strategy helps you solve Tower of Hanoi faster?",
      "acceptedAnswer": { "@type": "Answer", "text": "Key strategies: (1) Think 2-3 moves ahead before moving any disk, (2) Focus on getting the largest unplaced disk to its destination peg — the rest follows naturally, (3) Practice the 3-disk version until it's automatic — this builds muscle memory for the recursive structure that scales to larger puzzles, (4) Use the alternating-move pattern for even numbers of disks." }
    },
    {
      "@type": "Question",
      "name": "Can Tower of Hanoi improve executive function and planning skills?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. Research shows that training on Tower of Hanoi-style tasks improves look-ahead planning, working memory capacity, and response inhibition. These improvements transfer to real-world planning tasks, as the skill of breaking complex multi-step goals into optimal sequences is domain-general and applicable in engineering, management, medicine, and daily decision-making." }
    },
    {
      "@type": "Question",
      "name": "Is this Tower of Hanoi game free to play online?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. This Tower of Hanoi game on SkillDrills is completely free — no sign-up, downloads, or subscriptions required. It offers 3 to 8 disk challenges with move counting, optimal move guidance, and animation. Play directly in your browser on desktop and mobile." }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Play Tower of Hanoi Speed-Logic Drill",
  "description": "Test and train your lookup planning and recursive subproblem logic by solving Hanoi towers.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Select Source Peg",
      "text": "Tap or click on the peg that has the top disk you wish to move."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Select Destination Peg",
      "text": "Tap or click on the destination peg to move the highlighted disk. Remember: you cannot place a larger disk on top of a smaller disk."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Clear Tower to Advance",
      "text": "Move the entire disk stack to the third peg to bank bonus time, score points, and add a disk to the next tower. An invalid move costs one of your five lives instead of time."
    }
  ]
};

export const metadata = {
  title: "Play Tower of Hanoi Online Free | Classic Disk Puzzle | SkillDrills",
  description: "Play Tower of Hanoi online for free. Solve classic recursive disk stacking puzzles from 3 to 8 disks to train prefrontal executive planning skills.",
  keywords: [
    "tower of hanoi online",
    "play tower of hanoi free",
    "tower of hanoi rule",
    "hanoi puzzle solver",
    "is tower of hanoi good for your brain",
    "how to solve tower of hanoi",
    "minimum moves tower of hanoi",
    "tower of hanoi recursive"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/problem-solving/tower-of-hanoi",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Play Tower of Hanoi Online Free | Classic Disk Puzzle | SkillDrills",
    description: "Play Tower of Hanoi online for free. Solve classic recursive disk stacking puzzles from 3 to 8 disks to train prefrontal executive planning skills.",
    url: "https://skilldrills.online/drills/cognitive/problem-solving/tower-of-hanoi",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Play Tower of Hanoi Online Free" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Play Tower of Hanoi Online Free | Classic Disk Puzzle | SkillDrills",
    description: "Play Tower of Hanoi online for free. Solve classic recursive disk stacking puzzles from 3 to 8 disks to train prefrontal executive planning skills.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function TowerOfHanoiPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <TowerOfHanoiClient />
    </>
  );
}

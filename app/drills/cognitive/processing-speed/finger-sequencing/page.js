import Link from 'next/link';
import { 
  Activity, BarChart3, ChevronRight, Eye, GraduationCap, Info, Lightbulb, Target, TrendingUp, Users, ArrowRight, GitBranch, Crosshair
} from 'lucide-react';
import FingerSequencingClient from './FingerSequencingClient';

export const metadata = {
  title: "Sequence Aim Trainer - Mouse Accuracy Test | SkillDrills",
  description: "Improve mouse accuracy and finger speed with our free Sequence Aim Trainer. Practice sequential clicking, hand-eye coordination, and speed online.",
  keywords: [
    "sequence aim trainer",
    "mouse accuracy test",
    "sequential clicking game",
    "click speed test",
    "finger speed training",
    "mouse control game",
    "hand eye coordination test",
    "fast clicking game",
    "aim trainer sequence",
    "fps sequence practice",
    "valorant aim trainer",
    "cs2 aim trainer",
    "ordered clicking drill",
    "finger dexterity game",
    "motor sequencing drill",
    "free aim trainer online",
    "reaction time test"
  ],
  openGraph: {
    title: "Sequence Aim Trainer - Mouse Accuracy Test | SkillDrills",
    description: "Improve mouse accuracy and finger speed with our free Sequence Aim Trainer. Practice sequential clicking, hand-eye coordination, and speed online.",
    type: 'website',
    url: 'https://skilldrills.online/drills/cognitive/processing-speed/finger-sequencing',
    siteName: 'SkillDrills',
    locale: 'en_US',
    images: [{
      url: 'https://skilldrills.online/icons/icon-512x512.png',
      width: 512,
      height: 512,
      alt: 'Sequence Aim Trainer - Mouse Accuracy Test',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Sequence Aim Trainer - Mouse Accuracy Test | SkillDrills",
    description: "Improve mouse accuracy and finger speed with our free Sequence Aim Trainer. Practice sequential clicking, hand-eye coordination, and speed online.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
  robots: { index: true, follow: true },
  alternates: {
    canonical: 'https://skilldrills.online/drills/cognitive/processing-speed/finger-sequencing',
  },
};

export default function FingerSequencingPage() {
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Processing Speed", "item": "https://skilldrills.online/drills/cognitive/processing-speed" },
              { "@type": "ListItem", "position": 4, "name": "Finger Sequencing" }
            ]
  };

  const softwareSchema = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "name": "Sequence Aim Trainer - Mouse Accuracy Test",
    "url": "https://skilldrills.online/drills/cognitive/processing-speed/finger-sequencing",
    "description": "Free sequential aim trainer and mouse accuracy test. Click 3 connected nodes from largest to smallest before the timer expires. Endless difficulty scaling.",
    "applicationCategory": "GameApplication",
    "operatingSystem": "All",
    "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
    "author": { "@type": "Organization", "name": "SkillDrills" },
    "isAccessibleForFree": true
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "What is a sequence aim trainer?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "A sequence aim trainer is a specialized mouse accuracy tool designed to practice moving the crosshair to multiple targets in a specific order under time pressure, simulating multi-kill scenarios in FPS games."
        }
      },
      {
        "@type": "Question",
        "name": "How do I improve my mouse clicking accuracy?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "You can improve mouse accuracy by practicing sequential clicking games that force your brain to prioritize spatial order and precision over blind spam-clicking."
        }
      },
      {
        "@type": "Question",
        "name": "Is this a CPS (Clicks Per Second) test?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "No, this is not a raw CPS test. This tool tests accurate spatial clicking and finger sequencing, penalizing you for missed clicks rather than just measuring how fast you can mash a button."
        }
      },
      {
        "@type": "Question",
        "name": "Does sequential aim training help in FPS games?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Yes, it directly trains target-switching, crosshair pathing, and multi-kill sequencing in competitive shooters like Valorant, CS2, and Apex Legends."
        }
      },
      {
        "@type": "Question",
        "name": "How do you test hand-eye coordination?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "By measuring how fast your hand can accurately track and click descending node sizes before a dynamic sequence timer expires, tracking both speed and precision."
        }
      }
    ]
  };

  const howToSchema = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    "name": "How to Train Finger Sequencing",
    "description": "Step-by-step instructions to train sequential clicking accuracy and crosshair pathing speed.",
    "step": [
      {
        "@type": "HowToStep",
        "name": "Initiate target sequencing",
        "text": "Click the Start button. Multiple interconnected target nodes of varying sizes will render on the canvas."
      },
      {
        "@type": "HowToStep",
        "name": "Click in size order",
        "text": "Analyze target sizes immediately. Flick and click the nodes sequentially from largest to smallest before they timeout."
      },
      {
        "@type": "HowToStep",
        "name": "Maintain speed and precision",
        "text": "Avoid mashing your mouse buttons. Focus on smooth, rhythmic flicks between targets to maintain your streak value."
      }
    ]
  };

  return (
    <div className="min-h-screen bg-[#050508] text-white">
      {/* Breadcrumb Schema */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />

      {/* SoftwareApplication Schema */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareSchema) }}
      />

      {/* FAQPage Schema */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />

      {/* HowTo Schema */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }}
      />

      <FingerSequencingClient />

      {/* Static SEO & Marketing Sections */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <section className="mt-10">
          <div className="rounded-2xl border border-gray-800 overflow-hidden bg-gray-900 shadow-2xl">
            <div className="px-6 py-5 border-b border-gray-800 bg-black/40 flex items-center gap-3">
              <Info className="w-5 h-5 text-emerald-400" />
              <h2 className="font-bold text-white text-lg tracking-wide">Game Rules & Adaptive Progression</h2>
            </div>
            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-5">
                <RuleItem num="1" color="green" text="Sequential Aiming" highlight="Largest to Smallest" result="Click nodes in size/number order" />
                <RuleItem num="2" color="indigo" text="Zero Score Reduction" highlight="Streak Penalties Only" result="Points only rise, mistakes drop multiplier" />
              </div>
              <div className="space-y-5">
                <RuleItem num="3" color="red" text="Dynamic Timing" highlight="Survival System" result="Hits buy time, misses/timeouts drain it" />
                <RuleItem num="4" color="cyan" text="Tempo Leveling" highlight="Adaptive Index (1-10)" result="Harder cues, lengths & decoy trap nodes" />
              </div>
            </div>
          </div>
        </section>

        <article className="mt-12 text-gray-300">
          <div className="rounded-2xl border border-gray-800 overflow-hidden bg-gray-900 shadow-xl">
            <div className="px-6 py-5 border-b border-gray-800 bg-black/40 flex items-center gap-3">
              <GraduationCap className="w-5 h-5 text-emerald-400" />
              <h2 className="font-bold text-white text-lg tracking-wide">About the Sequence Aim Trainer</h2>
            </div>
            
            <div className="p-8 space-y-8">
              <section>
                <h2 className="text-xl font-bold text-white mb-3">Mastering the Mouse Accuracy Test</h2>
                <p className="text-sm leading-relaxed mb-4 font-sans">
                  This free sequential clicking game is designed to push your visual motor coordination and cursor control to the absolute limit. By demanding you assess sizes and click targets in a specific order, this aim trainer sequence forces players to transition from blind spam-clicking to highly deliberate, smooth pursuit tracking. There is no negative scoring—your goal is simply to survive the time drain by maintaining continuous accuracy to build massive combo multipliers. As your performance metrics rise, the game scales parameters adaptively, increasing sequence length, hiding labels, and placing decoy trap nodes.
                </p>
              </section>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-8">
                <div className="p-5 rounded-xl border bg-black/40 border-gray-800">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center"><Users className="w-4 h-4 text-white" /></div>
                    <h3 className="text-sm font-bold text-white">Who Should Play</h3>
                  </div>
                  <p className="text-xs leading-relaxed text-slate-400 font-sans">FPS gamers seeking a dedicated sequence aim trainer, esports competitors refining multi-kill pathing, and anyone testing their hand eye coordination.</p>
                </div>
                <div className="p-5 rounded-xl border bg-black/40 border-gray-800">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-green-600 flex items-center justify-center"><TrendingUp className="w-4 h-4 text-white" /></div>
                    <h3 className="text-sm font-bold text-white">Skills Targeted</h3>
                  </div>
                  <p className="text-xs leading-relaxed text-slate-400 font-sans">Improves ordered clicking, click speed test metrics, visual spatial coordinate snapping, and high-pressure reaction speed consistency.</p>
                </div>
                <div className="p-5 rounded-xl border bg-black/40 border-gray-800">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-lg bg-purple-600 flex items-center justify-center"><BarChart3 className="w-4 h-4 text-white" /></div>
                    <h3 className="text-sm font-bold text-white">What You'll Track</h3>
                  </div>
                  <p className="text-xs leading-relaxed text-slate-400 font-sans">Total gamified score, your click accuracy percentage, maximum combo streaks, total chains cleared, and performance grade.</p>
                </div>
              </div>
            </div>

            <div className="bg-[#0b0f19] border-t border-gray-800 p-8">
              <div className="flex items-center gap-3 mb-6">
                <Lightbulb className="w-6 h-6 text-yellow-400" />
                <h2 className="text-xl font-bold text-white">Frequently Asked Questions</h2>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FAQItem q="What is a sequence aim trainer?" a="A sequence aim trainer is a specialized mouse accuracy tool designed to practice moving the crosshair to multiple targets in a specific order under time pressure, simulating multi-kill scenarios in FPS games." />
                <FAQItem q="How do I improve my mouse clicking accuracy?" a="You can improve mouse accuracy by practicing sequential clicking games that force your brain to prioritize spatial order and precision over blind spam-clicking." />
                <FAQItem q="Is this a CPS (Clicks Per Second) test?" a="No, this is not a raw CPS test. This tool tests accurate spatial clicking and finger sequencing, penalizing you for missed clicks rather than just measuring how fast you can mash a button." />
                <FAQItem q="Does sequential aim training help in FPS games?" a="Yes, it directly trains target-switching, crosshair pathing, and multi-kill sequencing in competitive shooters like Valorant, CS2, and Apex Legends." />
                <FAQItem q="How do you test hand-eye coordination?" a="By measuring how fast your hand can accurately track and click descending node sizes before a dynamic sequence timer expires, tracking both speed and precision." />
                <FAQItem q="Is this mouse accuracy test free?" a="Yes, our sequence aim trainer is a free sequential clicking game online with no downloads required, offering immediate browser-based access to top-tier motor skills training." />
              </div>
            </div>
          </div>
        </article>

        <section className="mt-14" aria-label="Explore related hand eye coordination games">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1 h-5 rounded-full bg-emerald-500"></div>
            <h2 className="text-xs font-bold text-white uppercase tracking-widest font-mono">
              Explore More Aim Trainers
            </h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <RelatedCard href="/drills/cognitive/hand-eye-coordination/aim-trainer" title="Aim Trainer" desc="Hone click speed on shrinking targets." color="green" icon={<Target className="w-4 h-4" />} />
            <RelatedCard href="/drills/cognitive/flick-shot-training" title="Pro Flick Trainer" desc="Snap to targets in time-attack mode." color="blue" icon={<Crosshair className="w-4 h-4" />} />
            <RelatedCard href="/drills/cognitive/recoil-control" title="Recoil Control" desc="Calibrate pulling pattern compensation." color="red" icon={<Activity className="w-4 h-4" />} />
            <RelatedCard href="/drills/cognitive/hand-eye-coordination/precision-flick-shot" title="Tracking Game" desc="Smooth pursuit mouse control training." color="indigo" icon={<Eye className="w-4 h-4" />} />
          </div>
        </section>

        <footer className="mt-12 bg-[#05060b] border border-gray-800 text-gray-500 rounded-xl py-10 px-6 font-mono text-[10px]" role="contentinfo">
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-8 mb-8">
              <div>
                <h3 className="text-white font-bold mb-3 uppercase tracking-wider">Motor & FPS</h3>
                <ul className="space-y-2">
                  <li><Link href="/drills/cognitive/hand-eye-coordination/aim-trainer" className="hover:text-emerald-400 transition-colors">Aim Trainer Elite</Link></li>
                  <li><Link href="/drills/cognitive/flick-shot-training" className="hover:text-emerald-400 transition-colors">Flick Shot Trainer</Link></li>
                  <li><Link href="/drills/cognitive" className="text-emerald-500 hover:text-emerald-400 transition-colors font-bold">All FPS Drills →</Link></li>
                </ul>
              </div>
              <div>
                <h3 className="text-white font-bold mb-3 uppercase tracking-wider">Memory</h3>
                <ul className="space-y-2">
                  <li><Link href="/drills/cognitive/memory/grid-memorization" className="hover:text-emerald-400 transition-colors">3-Back Training</Link></li>
                  <li><Link href="/drills/cognitive/memory/memory-sequence" className="hover:text-emerald-400 transition-colors">Color Sequence</Link></li>
                  <li><Link href="/drills/cognitive" className="text-emerald-500 hover:text-emerald-400 transition-colors font-bold">All Cognitive Drills →</Link></li>
                </ul>
              </div>
              <div>
                <h3 className="text-white font-bold mb-3 uppercase tracking-wider">Cognitive</h3>
                <ul className="space-y-2">
                  <li><Link href="/drills/cognitive/memory/card-matching" className="hover:text-emerald-400 transition-colors">Memory Games</Link></li>
                  <li><Link href="/drills/cognitive/attention/divided-attention" className="hover:text-emerald-400 transition-colors">Attention Drills</Link></li>
                  <li><Link href="/drills/cognitive" className="text-emerald-500 hover:text-emerald-400 transition-colors font-bold">All Cognitive Drills →</Link></li>
                </ul>
              </div>
              <div>
                <h3 className="text-white font-bold mb-3 uppercase tracking-wider">Focus</h3>
                <ul className="space-y-2">
                  <li><Link href="/drills/cognitive/focus/concentration-grid" className="hover:text-emerald-400 transition-colors">Concentration Grid</Link></li>
                  <li><Link href="/drills/cognitive/focus/distraction-fighter" className="hover:text-emerald-400 transition-colors">Distraction Fighter</Link></li>
                  <li><Link href="/drills/cognitive?group=focus" className="text-emerald-500 hover:text-emerald-400 transition-colors font-bold">All Focus Drills →</Link></li>
                </ul>
              </div>
              <div>
                <h3 className="text-white font-bold mb-3 uppercase tracking-wider">More Sectors</h3>
                <ul className="space-y-2">
                  <li><Link href="/drills/cognitive" className="hover:text-emerald-400 transition-colors">Cognitive Drills</Link></li>
                  <li><Link href="/drills/cognitive" className="hover:text-emerald-400 transition-colors">Cognitive Drills</Link></li>
                </ul>
              </div>
            </div>
            
            <div className="border-t border-gray-800 pt-8 text-center">
              <div className="flex items-center justify-center gap-2 mb-4">
                <div className="w-6 h-6 bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 rounded-lg flex items-center justify-center">
                  <Target className="w-3.5 h-3.5 text-emerald-400" />
                </div>
                <span className="text-white font-black tracking-widest text-xs uppercase">SkillDrills</span>
              </div>
              <p className="text-[9px] mb-2">&copy; {new Date().getFullYear()} SkillDrills. All rights reserved.</p>
              <p className="text-[9px] max-w-2xl mx-auto leading-relaxed mb-6 font-sans text-gray-500">
                Open-source telemetry training platform using hardware pointer lock. Free forever. No downloads required.
              </p>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

// Subcomponents for SSR Page
function RuleItem({ num, color, text, highlight = '', result }) {
  const colorMap = { 
    blue: 'bg-blue-600 text-blue-300 border-blue-500', 
    indigo: 'bg-indigo-600 text-indigo-300 border-indigo-500', 
    purple: 'bg-purple-600 text-purple-300 border-purple-500',
    fuchsia: 'bg-fuchsia-600 text-fuchsia-300 border-fuchsia-500',
    gray: 'bg-gray-600 text-gray-300 border-gray-500', 
    green: 'bg-green-600 text-green-300 border-green-500',
    red: 'bg-red-600 text-red-300 border-red-500',
    orange: 'bg-orange-600 text-orange-300 border-orange-500',
    cyan: 'bg-cyan-600 text-cyan-300 border-cyan-500'
  };
  const colors = colorMap[color] || 'bg-slate-600 text-slate-300 border-slate-500';
  const [bg, txt, border] = colors.split(' ');
  
  return (
    <div className="flex items-center gap-4 bg-[#0b0f19]/40 p-4 rounded-xl border border-gray-800 shadow-sm">
      <div className={`w-8 h-8 rounded-xl ${bg} border border-t-white/20 flex items-center justify-center text-white text-base font-black shadow-lg flex-shrink-0`}>{num}</div>
      <div className="flex-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2 font-mono">
        <p className="text-sm font-medium text-gray-300">
          {text}{highlight && <span className={`font-black ${txt}`}> {highlight}</span>}
        </p>
        <div className={`text-xs font-black px-3 py-1.5 rounded-lg bg-[#050811] border ${border} ${txt} whitespace-nowrap shadow-inner tracking-wide text-center sm:text-left`}>
          {result}
        </div>
      </div>
    </div>
  );
}

function RelatedCard({ href, title, desc, color, icon }) {
  const gradients = {
    blue: 'from-blue-500 to-cyan-500',
    orange: 'from-orange-500 to-amber-500',
    red: 'from-red-500 to-rose-500',
    purple: 'from-purple-500 to-violet-500',
    green: 'from-green-500 to-emerald-500',
    indigo: 'from-indigo-500 to-purple-500'
  };
  return (
    <Link href={href} className="group relative overflow-hidden rounded-2xl border border-gray-800 bg-[#0b0f19]/40 transition-all hover:-translate-y-1 hover:border-gray-600 block p-5">
      <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${gradients[color]}`}></div>
      <div className="w-10 h-10 rounded-xl bg-[#050811] border border-gray-700 flex items-center justify-center text-gray-400 group-hover:text-white mb-3 shadow-inner">
        {icon}
      </div>
      <h3 className="font-bold text-base mb-1.5 text-white transition-colors">{title}</h3>
      <p className="text-xs text-gray-500 mb-4">{desc}</p>
      <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-bold opacity-0 group-hover:opacity-100 transition-opacity uppercase tracking-wider">
        Start Drill <ArrowRight className="w-3.5 h-3.5" />
      </div>
    </Link>
  );
}

function FAQItem({ q, a }) {
  return (
    <div className="bg-[#05060b] border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-colors">
      <h4 className="text-sm font-bold text-gray-200 mb-2">{q}</h4>
      <p className="text-xs text-gray-400 leading-relaxed font-sans">{a}</p>
    </div>
  );
}
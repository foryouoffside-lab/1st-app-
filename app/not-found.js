import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#050508] px-4">
      <div className="text-center max-w-md">
        <h1 className="text-7xl font-extrabold bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent mb-4">
          404
        </h1>
        <h2 className="text-2xl font-semibold text-white mb-2">Page Not Found</h2>
        <p className="text-white/60 mb-8">
          The drill page you&apos;re looking for doesn&apos;t exist or has been moved.<br />
          Explore our free training drills below.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/"
            className="px-6 py-3 bg-gradient-to-r from-blue-600 to-violet-600 text-white rounded-lg font-semibold hover:shadow-lg transition-all transform hover:scale-[1.02]"
          >
            Go Home
          </Link>
          <Link
            href="/drills/cognitive"
            className="px-6 py-3 bg-white/10 text-white rounded-lg font-semibold border border-white/15 hover:border-white/25 hover:bg-white/15 transition-all"
          >
            Cognitive Drills
          </Link>
        </div>
      </div>
    </div>
  );
}

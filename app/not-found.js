import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#050508] px-4">
      <div className="text-center max-w-md">
        <h1 className="text-7xl font-extrabold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent mb-4">
          404
        </h1>
        <h2 className="text-2xl font-semibold text-gray-900 mb-2">Page Not Found</h2>
        <p className="text-gray-600 mb-8">
          The drill page you&apos;re looking for doesn&apos;t exist or has been moved.<br />
          Explore our free training drills below.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/"
            className="px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg font-semibold hover:shadow-lg transition-all transform hover:scale-[1.02]"
          >
            Go Home
          </Link>
          <Link
            href="/drills/cognitive"
            className="px-6 py-3 bg-white text-gray-700 rounded-lg font-semibold border border-gray-300 hover:border-gray-400 hover:bg-gray-50 transition-all"
          >
            Cognitive Drills
          </Link>
        </div>
      </div>
    </div>
  );
}

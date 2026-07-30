import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, ReactNode } from "react";

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen p-8 bg-[#060a12]">
          <div className="flex flex-col items-center w-full max-w-2xl p-8">
            <AlertTriangle size={48} className="text-destructive mb-6" />
            <h2 className="text-xl mb-4 text-white">An unexpected error occurred.</h2>
            <div className="p-4 w-full rounded bg-slate-900 overflow-auto mb-6">
              <pre className="text-sm text-slate-400 whitespace-pre-wrap">{this.state.error?.stack}</pre>
            </div>
            <button onClick={() => window.location.reload()} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 text-black hover:opacity-90">
              <RotateCcw size={16} />Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;

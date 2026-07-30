import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Home } from "lucide-react";
import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#060a12]">
      <Card className="w-full max-w-lg mx-4 bg-[#0a0f1a] border-slate-800">
        <CardContent className="pt-8 pb-8 text-center">
          <AlertCircle className="h-16 w-16 text-red-500 mx-auto mb-6" />
          <h1 className="text-4xl font-bold text-white mb-2">404</h1>
          <p className="text-slate-400 mb-8">Page not found</p>
          <Button onClick={() => setLocation("/")} className="bg-amber-500 hover:bg-amber-600 text-black">
            <Home className="w-4 h-4 mr-2" />Go Home
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

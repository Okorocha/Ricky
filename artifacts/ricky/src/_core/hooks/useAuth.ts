// Simplified auth hook — all dashboard data is public in this deployment.
export function useAuth() {
  return {
    user: { name: "Ricky", role: "admin" } as const,
    loading: false,
    isAuthenticated: true,
    error: null,
    logout: async () => {},
  };
}

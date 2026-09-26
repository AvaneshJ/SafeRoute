import { AuthScreen } from "@/components/auth/AuthScreen";

/** Sign up entry — same Auth screen, signup mode. */
export default function SignupScreen() {
  return <AuthScreen initialMode="signup" />;
}

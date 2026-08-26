import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import appPackage from "../../../package.json";
import { Avatar } from "../../components/Avatar";
import { DisplayNameField } from "../../components/DisplayNameField";
import { serviceBaseUrl } from "../../config/serviceConfig";
import { passwordError, usernameError } from "../../core/authRules";
import {
  accountSession,
  type AccountState,
} from "../../services/accountSession";

const appVersion = appPackage.version;
const publicServiceUrl = serviceBaseUrl;

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="google-mark">
      <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.6h3.3c1.9-1.8 2.9-4.4 2.9-7.5Z" />
      <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.3l-3.3-2.6c-.9.6-2.1 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H3v2.7A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.4H3a10 10 0 0 0 0 9.2l3.4-2.7Z" />
      <path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.9 1.5l2.9-2.9A9.7 9.7 0 0 0 12 2a10 10 0 0 0-9 5.4l3.4 2.7C7.2 7.7 9.4 5.9 12 5.9Z" />
    </svg>
  );
}

export function AuthenticationGate({ state }: { state: AccountState }) {
  type Mode = "login" | "register" | "forgot" | "verification" | "recovery-code" | "reset";
  const [mode, setMode] = useState<Mode>(() =>
    state.status === "password-recovery" ? "reset" : state.status === "awaiting-verification" ? "verification" : "login",
  );
  const [identifier, setIdentifier] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [authAvatar, setAuthAvatar] = useState("");
  const [onboardingCodeSent, setOnboardingCodeSent] = useState(false);
  const authAvatarInput = useRef<HTMLInputElement>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resendDelay, setResendDelay] = useState(0);

  useEffect(() => {
    if (state.status === "password-recovery") setMode("reset");
    if (state.status === "awaiting-verification") {
      setEmail(state.email);
      setMode("verification");
    }
    if (state.status === "onboarding") {
      setEmail(state.email);
      setUsername(state.username);
      setDisplayName(state.displayName);
      setAuthAvatar(state.avatarUrl || "");
      setVerificationCode("");
      setOnboardingCodeSent(false);
    }
  }, [state]);
  useEffect(() => {
    if (resendDelay <= 0) return;
    const timer = window.setInterval(() => setResendDelay((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendDelay]);

  const pending = busy || state.status === "checking" || state.status === "authenticating";
  const changeMode = (next: Mode) => {
    accountSession.clearAuthError();
    setMode(next); setError(""); setNotice(""); setVerificationCode("");
  };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong. Try again."); }
    finally { setBusy(false); }
  };
  const selectAuthAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
      setError("Choose an image that is 5 MB or smaller");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAuthAvatar(String(reader.result || ""));
    reader.onerror = () => setError("Could not read this image");
    reader.readAsDataURL(file);
  };
  const avatarPicker = (
    <div className="auth-avatar-picker">
      <Avatar value={authAvatar || displayName.slice(0, 1) || "M"} />
      <div>
        <button type="button" className="auth-text-button" onClick={() => authAvatarInput.current?.click()}>Choose profile photo</button>
        {authAvatar && <button type="button" className="auth-text-button" onClick={() => setAuthAvatar("")}>Remove photo</button>}
      </div>
      <input ref={authAvatarInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={selectAuthAvatar} />
    </div>
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === "login") {
      void perform(() => accountSession.login(identifier, password));
      return;
    }
    if (mode === "forgot") {
      void perform(async () => {
        await accountSession.requestPasswordReset(identifier);
        setEmail(identifier.trim());
        setVerificationCode("");
        setMode("recovery-code");
        setNotice("If an account matches this information, a recovery code has been sent.");
      });
      return;
    }
    if (mode === "recovery-code") {
      void perform(() => accountSession.verifyPasswordRecoveryCode(email, verificationCode));
      return;
    }
    if (mode === "register") {
      void perform(async () => {
        const invalidUsername = usernameError(username);
        if (invalidUsername) throw new Error(invalidUsername);
        const invalidPassword = passwordError(password);
        if (invalidPassword) throw new Error(invalidPassword);
        if (password !== confirmation) throw new Error("Passwords do not match");
        if (!acceptedTerms) throw new Error("Accept the Terms and Privacy Policy to continue");
        if (!(await accountSession.usernameAvailable(username))) throw new Error("Username is unavailable");
        await accountSession.register(username, displayName, email, password);
      });
      return;
    }
    if (mode === "reset") {
      void perform(async () => {
        const invalidPassword = passwordError(password);
        if (invalidPassword) throw new Error(invalidPassword);
        if (password !== confirmation) throw new Error("Passwords do not match");
        await accountSession.completePasswordRecovery(password);
      });
    }
  };

  return (
    <section className="auth-gate-card auth-professional" aria-label="MHTalk account">
      <div className="auth-brand">
        <div className="auth-gate-logo" aria-hidden="true">M</div>
        <div><h1>MHTalk</h1><small>Voice, video and rooms · v{appVersion}</small></div>
      </div>

      {state.status === "checking" ? (
        <div className="auth-gate-progress"><i /> Restoring your secure session…</div>
      ) : state.status === "onboarding" ? (
        <div className="auth-message-panel auth-onboarding">
          <GoogleMark />
          <h2>{onboardingCodeSent ? "Verify account creation" : "Finish your MHTalk account"}</h2>
          {!onboardingCodeSent ? <>
            <p>Google verified <strong>{state.email}</strong>. Choose how your MHTalk profile will appear.</p>
            {avatarPicker}
            <label>Email<input value={state.email} readOnly /></label>
            <DisplayNameField label="Display name" value={displayName} onValueChange={setDisplayName} placeholder="Your display name" />
            <label>Username<input value={username} onChange={(event) => setUsername(event.target.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 32))} placeholder="your_username" /></label>
            {error && <div className="auth-alert" role="alert">{error}</div>}
            <button className="primary" disabled={pending} onClick={() => void perform(async () => {
              const invalidUsername = usernameError(username);
              if (invalidUsername) throw new Error(invalidUsername);
              if (!displayName.trim()) throw new Error("Enter a display name");
              await accountSession.startGoogleOnboarding();
              setVerificationCode(""); setOnboardingCodeSent(true); setResendDelay(60);
            })}>{pending ? "Please wait…" : "Send account creation code"}</button>
          </> : <>
            <p>Enter the account creation code sent to <strong>{state.email}</strong>.</p>
            <label>Account creation code<input inputMode="numeric" autoComplete="one-time-code" value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="Account creation code" minLength={6} maxLength={8} /></label>
            {error && <div className="auth-alert" role="alert">{error}</div>}
            {notice && <div className="auth-notice" role="status">{notice}</div>}
            <button className="primary" disabled={pending || verificationCode.length < 6} onClick={() => void perform(() => accountSession.completeGoogleOnboarding(username, displayName, authAvatar || undefined, verificationCode))}>Verify and enter MHTalk</button>
            <button className="auth-text-button" disabled={pending || resendDelay > 0} onClick={() => void perform(async () => {
              await accountSession.startGoogleOnboarding(); setResendDelay(60); setNotice("A new account creation code was sent.");
            })}>{resendDelay > 0 ? `Resend in ${resendDelay}s` : "Resend account creation code"}</button>
            <button className="auth-text-button" onClick={() => { setOnboardingCodeSent(false); setError(""); setNotice(""); }}>Edit profile details</button>
          </>}
          <button className="auth-text-button" onClick={() => void accountSession.signOut()}>Cancel and sign out</button>
        </div>
      ) : state.status === "awaiting-oauth" ? (
        <div className="auth-message-panel">
          <GoogleMark />
          <h2>Finish signing in with Google</h2>
          <p>Choose your Google account in the browser window. MHTalk will continue automatically when Google sends you back.</p>
          <div className="auth-gate-progress"><i /> Waiting for Google…</div>
          <button className="auth-text-button" type="button" onClick={() => accountSession.cancelOAuthSignIn()}>Cancel and return to login</button>
        </div>
      ) : state.status === "account-exists" ? (
        <div className="auth-message-panel">
          <div className="auth-message-icon">!</div>
          <h2>Account already exists</h2>
          <p>{state.message}</p>
          <strong>{state.email}</strong>
          {error && <div className="auth-alert" role="alert">{error}</div>}
          <button className="primary" disabled={pending} onClick={() => void perform(async () => {
            await accountSession.requestPasswordReset(state.email);
            accountSession.dismissAccountNotice();
            setEmail(state.email); setVerificationCode(""); setMode("recovery-code");
            setNotice("A password setup code was sent.");
          })}>{state.passwordEnabled ? "Reset password" : "Set a password"}</button>
          {state.googleLinked && <button className="auth-google" type="button" disabled={pending} onClick={() => void perform(() => accountSession.signIn("google"))}><GoogleMark />Log in using Google</button>}
          <button className="auth-text-button" onClick={() => { accountSession.dismissAccountNotice(); changeMode("login"); }}>Back to login</button>
        </div>
      ) : mode === "verification" ? (
        <div className="auth-message-panel">
          <div className="auth-message-icon">✉</div>
          <h2>Verify your email</h2>
          <p>Enter the verification code sent to <strong>{email}</strong>. You can also use the link in the same email.</p>
          <label>Verification code<input inputMode="numeric" autoComplete="one-time-code" value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="Verification code" required minLength={6} maxLength={8} /></label>
          {error && <div className="auth-alert" role="alert">{error}</div>}
          {notice && <div className="auth-notice" role="status">{notice}</div>}
          <button className="primary" disabled={pending || verificationCode.length < 6} onClick={() => void perform(() => accountSession.verifyEmailCode(email, verificationCode, displayName, authAvatar || undefined))}>Verify and continue</button>
          <button className="primary" disabled={pending || resendDelay > 0} onClick={() => void perform(async () => {
            await accountSession.resendVerification(email); setResendDelay(60); setNotice("A new verification code was sent.");
          })}>{resendDelay > 0 ? `Resend in ${resendDelay}s` : "Resend verification code"}</button>
          <button className="auth-text-button" onClick={() => { setIdentifier(email); changeMode("forgot"); }}>Already use this email? Set a password</button>
          <button className="auth-text-button" onClick={() => changeMode("login")}>Back to login</button>
        </div>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <header>
            <h2>{mode === "login" ? "Welcome back" : mode === "register" ? "Create your account" : mode === "forgot" ? "Reset your password" : mode === "recovery-code" ? "Enter recovery code" : "Choose a new password"}</h2>
            <p>{mode === "login" ? "Sign in to continue to MHTalk." : mode === "register" ? "One account works on phone and PC." : mode === "forgot" ? "Enter your username or email and we’ll send a recovery code." : mode === "recovery-code" ? `Enter the code sent to ${email}.` : "Use at least 10 characters for your new password."}</p>
          </header>

          {mode === "register" && <>
            {avatarPicker}
            <label>Username<input value={username} onChange={(event) => setUsername(event.target.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 32))} autoComplete="username" placeholder="your_username" required minLength={3} /></label>
            <DisplayNameField label="Display name" value={displayName} onValueChange={setDisplayName} autoComplete="name" placeholder="How people will see you" required />
            <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="you@example.com" required /></label>
          </>}

          {(mode === "login" || mode === "forgot") &&
            <label>Username or Email<input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" placeholder="Username or Email" required autoFocus /></label>}

          {mode === "recovery-code" &&
            <label>Recovery code<input inputMode="numeric" autoComplete="one-time-code" value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="Recovery code" required minLength={6} maxLength={8} autoFocus /></label>}

          {(mode === "login" || mode === "register" || mode === "reset") && <>
            <label>Password<div className="password-field"><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="Password" required minLength={mode === "login" ? undefined : 10} /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></div></label>
            {(mode === "register" || mode === "reset") && <label>Confirm password<input type={showPassword ? "text" : "password"} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" placeholder="Confirm password" required minLength={10} /></label>}
          </>}

          {mode === "login" && <div className="auth-secondary-links"><button type="button" onClick={() => changeMode("register")}>Register new account</button><button type="button" onClick={() => changeMode("forgot")}>Forgot password?</button></div>}
          {mode === "register" && <div className="auth-terms">
            <input type="checkbox" aria-label="Accept Terms of Service and Privacy Policy" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} />
            <span>I agree to the <button className="auth-inline-link" type="button" onClick={() => void openUrl(`${publicServiceUrl}/terms`)}>Terms of Service</button> and <button className="auth-inline-link" type="button" onClick={() => void openUrl(`${publicServiceUrl}/privacy`)}>Privacy Policy</button>.</span>
          </div>}

          {(error || (state.status === "failed" && !error)) && <div className="auth-alert" role="alert">{error || state.status === "failed" && state.message}</div>}
          {notice && <div className="auth-notice" role="status">{notice}</div>}
          {state.status === "unavailable" && <div className="auth-alert">Account service is unavailable. Check your connection and try again.</div>}

          <button className="primary auth-submit" type="submit" disabled={pending || mode === "recovery-code" && verificationCode.length < 6}>{pending ? "Please wait…" : mode === "login" ? "Login" : mode === "register" ? "Create account" : mode === "forgot" ? "Send recovery code" : mode === "recovery-code" ? "Verify code" : "Save new password"}</button>

          {mode === "login" && <>
            <div className="auth-divider"><span>OR</span></div>
            <button className="auth-google" type="button" disabled={pending} onClick={() => void perform(() => accountSession.signIn("google"))}><GoogleMark />Log in using Google</button>
          </>}
          {mode !== "login" && mode !== "reset" && <button className="auth-text-button" type="button" onClick={() => changeMode(mode === "recovery-code" ? "forgot" : "login")}>{mode === "recovery-code" ? "Use another email" : "Back to login"}</button>}
          {mode === "reset" && <button className="auth-text-button" type="button" onClick={() => void accountSession.cancelPasswordRecovery()}>Cancel</button>}
        </form>
      )}
      <footer className="auth-footer">Protected sign-in · Your password is never stored by MHTalk</footer>
    </section>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/i18n-provider";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  isFirstRun: boolean;
}

type Step = "credentials" | "mfa" | "enroll";

export function LoginForm({ isFirstRun }: Props) {
  const t = useT();
  const [step, setStep] = useState<Step>("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enroll, setEnroll] = useState<{ qr: string; secret: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  function finish() {
    router.push("/dashboard");
    router.refresh();
  }

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(isFirstRun ? "/api/setup" : "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t("login.error.generic"));
        return;
      }

      if (data.mfa === "verify") {
        setStep("mfa");
        return;
      }
      if (data.mfa === "enroll") {
        const er = await fetch("/api/mfa/enroll", { method: "POST" });
        const ed = await er.json();
        if (!er.ok) {
          setError(ed.error || t("login.error.generic"));
          return;
        }
        setEnroll({ qr: ed.qr, secret: ed.secret });
        setStep("enroll");
        return;
      }

      finish();
    } catch {
      setError(t("login.error.connection"));
    } finally {
      setLoading(false);
    }
  }

  async function handleCode(e: React.FormEvent, url: string) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t("login.error.generic"));
        return;
      }
      finish();
    } catch {
      setError(t("login.error.connection"));
    } finally {
      setLoading(false);
    }
  }

  const codeField = (
    <div className="space-y-2">
      <Label htmlFor="code">{t("login.mfaCode")}</Label>
      <Input
        id="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="123456"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        required
        className="h-11 tracking-[0.4em] text-center text-lg font-mono"
      />
    </div>
  );

  const errorBox = error && (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
      {error}
    </div>
  );

  if (step === "mfa") {
    return (
      <Card className="login-card border-border bg-card backdrop-blur">
        <CardHeader>
          <CardTitle className="text-2xl">{t("login.mfaTitle")}</CardTitle>
          <CardDescription>{t("login.mfaHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => handleCode(e, "/api/mfa/verify")} className="space-y-5">
            {codeField}
            {errorBox}
            <Button
              type="submit"
              className="w-full h-11 text-base font-medium bg-emerald-500 hover:bg-emerald-600 text-black"
              disabled={loading || code.length !== 6}
            >
              {loading ? "…" : t("login.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  if (step === "enroll") {
    return (
      <Card className="login-card border-border bg-card backdrop-blur">
        <CardHeader>
          <CardTitle className="text-2xl">{t("login.enrollTitle")}</CardTitle>
          <CardDescription>{t("login.enrollHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-3 mb-5">
            {enroll?.qr && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={enroll.qr}
                alt="QR"
                width={200}
                height={200}
                className="rounded-lg border border-border bg-white p-2"
              />
            )}
            <div className="text-center">
              <div className="text-xs text-muted-foreground">{t("login.enrollManual")}</div>
              <code className="text-xs font-mono break-all">{enroll?.secret}</code>
            </div>
          </div>
          <form onSubmit={(e) => handleCode(e, "/api/mfa/confirm")} className="space-y-5">
            {codeField}
            {errorBox}
            <Button
              type="submit"
              className="w-full h-11 text-base font-medium bg-emerald-500 hover:bg-emerald-600 text-black"
              disabled={loading || code.length !== 6}
            >
              {loading ? "…" : t("login.enrollSubmit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="login-card border-border bg-card backdrop-blur">
      <CardHeader>
        <CardTitle className="text-2xl">
          {isFirstRun ? t("login.setupTitle") : t("login.title")}
        </CardTitle>
        <CardDescription>
          {isFirstRun ? t("login.firstRunHint") : t("login.hint")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleCredentials} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="username">{t("login.username")}</Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="janek"
              autoComplete="username"
              required
              className="h-11"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">{t("login.password")}</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete={isFirstRun ? "new-password" : "current-password"}
              required
              minLength={6}
              className="h-11"
            />
            {isFirstRun && (
              <p className="text-xs text-muted-foreground">{t("login.minChars")}</p>
            )}
          </div>

          {errorBox}

          <Button
            type="submit"
            className="w-full h-11 text-base font-medium bg-emerald-500 hover:bg-emerald-600 text-black"
            disabled={loading}
          >
            {loading
              ? "Przetwarzanie..."
              : isFirstRun
                ? t("login.setupSubmit")
                : t("login.submit")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

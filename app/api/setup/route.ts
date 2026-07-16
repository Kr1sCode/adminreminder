import { NextRequest, NextResponse } from "next/server";
import { createUser, login, needsSetup } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const isFirstRun = await needsSetup();
    if (!isFirstRun) {
      return NextResponse.json({ error: "Instalacja już zakończona" }, { status: 400 });
    }

    const { username, password } = await request.json();

    if (!username || !password) {
      return NextResponse.json({ error: "Podaj nazwę użytkownika i hasło" }, { status: 400 });
    }

    const result = await createUser(username, password, "admin");

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    // Automatically log the user in after creating the account
    await login(username, password);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Wewnętrzny błąd serwera" }, { status: 500 });
  }
}

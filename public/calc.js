(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GiderCalc = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Math.round((x + Number.EPSILON) * 100) / 100;
  }

  function parseMoney(value) {
    let s = String(value ?? "").trim().replace(/\s/g, "");
    if (!s) return NaN;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    const n = Number(s);
    if (!Number.isFinite(n)) return NaN;
    return money(n);
  }

  function formatMoney(n) {
    const value = Number(n) || 0;
    const negative = value < 0;
    const abs = Math.abs(value);
    const hasCents = Math.round(abs * 100) % 100 !== 0;
    const formatted = new Intl.NumberFormat("tr-TR", {
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(abs);
    return `${negative ? "-" : ""}${formatted} ₺`;
  }

  function formatYearMonth(date) {
    const raw = new Intl.DateTimeFormat("tr-TR", {
      month: "long",
      year: "numeric",
    }).format(date);
    return raw.charAt(0).toLocaleUpperCase("tr-TR") + raw.slice(1);
  }

  function formatShortDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return new Intl.DateTimeFormat("tr-TR", {
      day: "numeric",
      month: "short",
    }).format(new Date(y, m - 1, d));
  }

  function isoDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function currentMonth(today = new Date()) {
    return isoDate(today).slice(0, 7);
  }

  function daysInMonth(month) {
    const [y, m] = month.split("-").map(Number);
    return new Date(y, m, 0).getDate();
  }

  function shiftMonth(month, delta) {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function monthsToPayoff(balance, payment, annualRate) {
    const b = money(balance);
    const p = money(payment);
    const rate = Number(annualRate) || 0;
    const monthlyInterest = money(b * (rate / 100 / 12));
    if (b <= 0) return { months: 0, impossible: false, monthlyInterest: 0 };
    if (p <= 0) return { months: Infinity, impossible: true, monthlyInterest };
    const r = rate / 100 / 12;
    if (r === 0) {
      return { months: Math.ceil(b / p - 1e-9), impossible: false, monthlyInterest: 0 };
    }
    if (p <= b * r + 1e-9) {
      return { months: Infinity, impossible: true, monthlyInterest };
    }
    const n = Math.log(p / (p - b * r)) / Math.log(1 + r);
    return { months: Math.ceil(n - 1e-9), impossible: false, monthlyInterest };
  }

  function describePayoff(balance, payment, annualRate, today = new Date()) {
    const calc = monthsToPayoff(balance, payment, annualRate);
    const b = money(balance);
    const p = money(payment);
    if (b <= 0) {
      return {
        ...calc,
        payoffLabel: null,
        totalPaid: 0,
        interest: 0,
        message: "Bu borç kapanmış görünüyor.",
      };
    }
    if (!(p > 0)) {
      return {
        ...calc,
        payoffLabel: null,
        totalPaid: null,
        interest: null,
        message: "Kapanış tarihi için aylık ödeme yaz.",
      };
    }
    if (calc.impossible) {
      return {
        ...calc,
        payoffLabel: null,
        totalPaid: null,
        interest: null,
        message: `Bu taksit borcu kapatmıyor. Aylık faiz yaklaşık ${formatMoney(calc.monthlyInterest)}. Bunun üstünde ödemen gerekir.`,
      };
    }
    const payoff = new Date(today.getFullYear(), today.getMonth() + calc.months - 1, 1);
    const payoffLabel = formatYearMonth(payoff);
    const totalPaid = money(p * calc.months);
    const interest = money(Math.max(0, totalPaid - b));
    let message = `${calc.months} taksit · bitiş ${payoffLabel}`;
    if ((Number(annualRate) || 0) > 0) {
      message += `. Toplam yaklaşık ${formatMoney(totalPaid)}, bunun ${formatMoney(interest)} kadarı faiz.`;
    } else {
      message += `. Toplam ${formatMoney(totalPaid)}.`;
    }
    return { ...calc, payoffLabel, totalPaid, interest, message };
  }

  // Değişken pay = maaş + o ayın ekstra geliri - sabit gider - borç taksiti.
  function monthSummary(state, month, today = new Date()) {
    const todayDate = today instanceof Date ? today : new Date(today);
    const todayIso = isoDate(todayDate);
    const todayKey = todayIso.slice(0, 7);
    const salary = money(state.salary);
    const extraTotal = money((state.extras || []).filter((item) => item.month === month).reduce((sum, item) => sum + money(item.amount), 0));
    const income = money(salary + extraTotal);
    const fixedTotal = money((state.fixed || []).reduce((sum, item) => sum + money(item.amount), 0));
    const debtPayment = money((state.debts || []).reduce((sum, item) => sum + money(item.monthlyPayment), 0));
    const committed = money(fixedTotal + debtPayment);
    const variableBudget = money(income - committed);
    const expenses = (state.expenses || []).filter((item) => item.date && item.date.startsWith(`${month}-`));
    const spent = money(expenses.reduce((sum, item) => sum + money(item.amount), 0));
    const remaining = money(variableBudget - spent);
    const dim = daysInMonth(month);
    const when = month === todayKey ? "current" : month < todayKey ? "past" : "future";
    const daysLeft = when === "current" ? dim - todayDate.getDate() + 1 : null;
    let dailyAllowance = null;
    if (daysLeft) {
      if (remaining <= 0) dailyAllowance = 0;
      else {
        const raw = remaining / daysLeft;
        dailyAllowance = raw >= 1 ? Math.floor(raw + 1e-9) : money(Math.floor(raw * 100) / 100);
      }
    }
    const byCategory = {};
    for (const item of expenses) {
      byCategory[item.category] = money((byCategory[item.category] || 0) + item.amount);
    }
    const todaySpent = money(
      expenses.filter((item) => item.date === todayIso).reduce((sum, item) => sum + item.amount, 0)
    );
    let ahead = false;
    if (when === "current" && variableBudget > 0) {
      const expected = variableBudget * (todayDate.getDate() / dim);
      ahead = spent > expected * 1.15 && spent - expected >= 100;
    }
    return {
      salary,
      extraTotal,
      income,
      fixedTotal,
      debtPayment,
      committed,
      variableBudget,
      spent,
      remaining,
      daysInMonth: dim,
      daysLeft,
      dailyAllowance,
      byCategory,
      todaySpent,
      when,
      hasIncome: income > 0,
      committedOver: variableBudget < 0,
      overspent: remaining < 0,
      ahead,
      expenses,
    };
  }

  function buildAdvice(summary, labelById) {
    const labels = labelById || {};
    const discretionary = ["yemek", "eglence", "giyim", "kisisel"];
    const avoid = [];
    if (summary.hasIncome && summary.variableBudget > 0) {
      for (const id of discretionary) {
        const amount = summary.byCategory[id] || 0;
        if (amount > summary.variableBudget * 0.25) avoid.push(labels[id] || id);
      }
    }
    const avoidText = avoid.length ? `Bugün şunları kes: ${avoid.join(", ")}.` : "";

    if (!summary.hasIncome) {
      return {
        tone: "setup",
        eyebrow: "Önce bu",
        amount: null,
        amountText: "Gelirini yaz",
        detail: "Maaşını yaz. O ay başka yerden para geldiyse onu da ekle. Limit ancak ondan sonra gerçek olur.",
        avoid,
      };
    }

    if (summary.when === "current" && summary.committedOver) {
      return {
        tone: "bad",
        eyebrow: "Bugün dur",
        amount: 0,
        detail: `Sabit gider ve taksit, eline geçenden ${formatMoney(Math.abs(summary.variableBudget))} fazla. Harcayacak pay yok.`,
        avoid,
      };
    }

    if (summary.when === "current" && summary.overspent) {
      const second = avoidText || "Bugün yeni bir şey alma.";
      return {
        tone: "bad",
        eyebrow: "Limit bitti",
        amount: 0,
        detail: `${formatMoney(Math.abs(summary.remaining))} açık var. ${second}`,
        avoid,
      };
    }

    if (summary.when === "current") {
      const dayText = summary.daysLeft === 1 ? "1 gün kaldı" : `${summary.daysLeft} gün kaldı`;
      const bits = [`${dayText}. Kasada ${formatMoney(summary.remaining)} var.`];
      if (summary.todaySpent > 0) bits.push(`Bugün ${formatMoney(summary.todaySpent)} yazdın.`);
      if (avoidText) bits.push(avoidText);
      else if (summary.ahead) bits.push("Tempo yüksek. Bugün tavanı geçme.");
      else if (summary.fixedTotal === 0) bits.push("Kira ve faturayı da yaz, yoksa bu sayı şişer.");
      else if (summary.committed > summary.income * 0.7) bits.push("Paranın çoğu sabit gidere ve borca gidiyor.");
      else bits.push("Bunu geçmezsen ayı artıda kapatırsın.");
      return {
        tone: summary.ahead || avoid.length ? "warn" : "ok",
        eyebrow: "Bugünlük tavan",
        amount: summary.dailyAllowance,
        detail: bits.join(" "),
        avoid,
      };
    }

    const closed = summary.overspent || summary.committedOver;
    return {
      tone: closed ? "bad" : "ok",
      eyebrow: closed ? "Açık" : summary.when === "future" ? "Ayrılan pay" : "Ay sonu",
      amount: Math.abs(summary.remaining),
      detail:
        summary.when === "future"
          ? "Bu ay daha gelmedi. Günlük tavan, aya girince kalan günlere bölünür."
          : `Gelir ${formatMoney(summary.income)}, harcama ${formatMoney(summary.spent)}.`,
      avoid: [],
    };
  }

  return {
    money,
    parseMoney,
    formatMoney,
    formatYearMonth,
    formatShortDate,
    isoDate,
    currentMonth,
    daysInMonth,
    shiftMonth,
    monthsToPayoff,
    describePayoff,
    monthSummary,
    buildAdvice,
  };
});

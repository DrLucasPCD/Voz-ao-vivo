export type ConsultationSpeaker = "doctor" | "patient" | "team";
export type ConsultationUtteranceKind =
  | "question"
  | "orientation"
  | "conduct"
  | "information";

export type ConsultationTurn = {
  id: string;
  speaker: ConsultationSpeaker;
  text: string;
  kind: ConsultationUtteranceKind;
  createdAt: string;
  source: "microphone" | "quick-action" | "typed";
};

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const containsAny = (text: string, terms: string[]) => {
  const normalized = normalize(text);
  return terms.some((term) => normalized.includes(normalize(term)));
};

export function classifyDoctorUtterance(
  text: string,
): ConsultationUtteranceKind {
  if (
    containsAny(text, [
      "oriento",
      "recomendo",
      "evite",
      "mantenha",
      "procure atendimento",
      "retorne",
      "sinais de alerta",
      "é importante",
    ])
  ) {
    return "orientation";
  }
  if (
    containsAny(text, [
      "vou examinar",
      "vou medir",
      "vou solicitar",
      "vou encaminhar",
      "vou discutir",
      "conduta",
      "plano terapêutico",
      "exame físico",
    ])
  ) {
    return "conduct";
  }
  if (/\?\s*$/.test(text.trim()) || containsAny(text, ["como", "quando", "onde", "qual", "quanto", "você", "o senhor", "a senhora"])) {
    return "question";
  }
  return "information";
}

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function uniqueTexts(turns: ConsultationTurn[]) {
  const seen = new Set<string>();
  return turns
    .map((turn) => turn.text.trim())
    .filter((text) => {
      const key = normalize(text);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sectionOrNotInformed(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "Não informado na conversa.";
}

const SECTION_RULES = {
  medications: ["medicamento", "remédio", "dose", "horário", "alergia", "reação"],
  history: ["já tive", "cirurgia", "internação", "doença", "hipertensão", "diabetes", "avc", "infarto", "asma"],
  family: ["família", "mãe", "pai", "irmão", "avó", "hereditário"],
  habits: ["fumo", "cigarro", "álcool", "droga", "atividade física", "alimentação", "trabalho", "moradia"],
  reproductive: ["menstruação", "menarca", "gestação", "gravidez", "parto", "aborto", "contraceptivo", "relação sexual"],
  pediatric: ["nasceu", "parto", "amament", "vacina", "desenvolvimento", "escola", "alimentação da criança"],
  adolescent: ["escola", "família", "casa", "amigos", "bullying", "droga", "álcool", "sexual", "seguro", "violência", "projeto de vida"],
  geriatric: ["queda", "memória", "esquec", "banho", "vestir", "finanças", "telefone", "fragilidade", "cuidador"],
  mental: ["triste", "ansiedade", "humor", "sono", "suic", "morte", "alucina", "pânico", "autoles"],
} as const;

function patientSection(turns: ConsultationTurn[], rules: readonly string[]) {
  return uniqueTexts(
    turns.filter(
      (turn) => turn.speaker === "patient" && containsAny(turn.text, [...rules]),
    ),
  );
}

export function buildClinicalRecord(
  turns: ConsultationTurn[],
  specialty: string,
) {
  const patientTurns = turns.filter((turn) => turn.speaker === "patient");
  const doctorTurns = turns.filter((turn) => turn.speaker === "doctor");
  const teamTurns = turns.filter((turn) => turn.speaker === "team");
  const firstPatientReport = patientTurns[0]?.text.trim();
  const hda = uniqueTexts(patientTurns);
  const conducts = uniqueTexts(
    doctorTurns.filter((turn) => turn.kind === "conduct"),
  );
  const orientations = uniqueTexts(
    doctorTurns.filter((turn) => turn.kind === "orientation"),
  );
  const hypotheses = uniqueTexts(
    [...doctorTurns, ...teamTurns].filter((turn) =>
      containsAny(turn.text, ["hipótese", "diagnóstico", "diferencial", "problema"]),
    ),
  );
  const examination = uniqueTexts(
    turns.filter((turn) =>
      containsAny(turn.text, [
        "exame físico",
        "pressão",
        "frequência cardíaca",
        "saturação",
        "ausculta",
        "palpação",
        "inspeção",
      ]),
    ),
  );

  const chronology = turns.length
    ? turns
        .map((turn) => {
          const speaker =
            turn.speaker === "doctor"
              ? "Acadêmico"
              : turn.speaker === "patient"
                ? "Paciente"
                : "Equipe/preceptoria";
          return `[${formatDate(turn.createdAt)}] ${speaker}: ${turn.text}`;
        })
        .join("\n")
    : "Nenhuma fala registrada.";

  const consultationStartedAt = turns[0]?.createdAt ?? new Date().toISOString();

  return `PRONTUÁRIO DA CONSULTA - RASCUNHO PARA REVISÃO
Data/hora: ${formatDate(consultationStartedAt)}
Contexto: ${specialty}

IDENTIFICAÇÃO
Não informada automaticamente. Preencha somente os dados necessários no sistema oficial.

QUEIXA PRINCIPAL E DURAÇÃO
${firstPatientReport ?? "Não informado na conversa."}

HISTÓRIA DA DOENÇA ATUAL
${sectionOrNotInformed(hda)}

INTERROGATÓRIO SINTOMATOLÓGICO
${sectionOrNotInformed(hda.slice(1))}

ANTECEDENTES PESSOAIS E PATOLÓGICOS
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.history))}

MEDICAMENTOS E ALERGIAS
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.medications))}

ANTECEDENTES FAMILIARES
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.family))}

HÁBITOS DE VIDA E CONTEXTO SOCIAL
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.habits))}

SAÚDE SEXUAL, GINECOLÓGICA E OBSTÉTRICA
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.reproductive))}

CRESCIMENTO, HISTÓRIA PRÉ-NATAL/NATAL, DESENVOLVIMENTO E IMUNIZAÇÕES
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.pediatric))}

CONTEXTO DO ADOLESCENTE (ESCOLA, CASA, ATIVIDADES, DROGAS, EMOÇÕES, SEXUALIDADE E SEGURANÇA)
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.adolescent))}

FUNCIONALIDADE E AVALIAÇÃO GERIÁTRICA
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.geriatric))}

SAÚDE MENTAL E AVALIAÇÃO DE RISCO
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.mental))}

EXAME FÍSICO E/OU ESTADO MENTAL
${sectionOrNotInformed(examination)}

LISTA DE PROBLEMAS
${sectionOrNotInformed(hda)}

HIPÓTESES DIAGNÓSTICAS E DIFERENCIAIS
${sectionOrNotInformed(hypotheses)}

CONDUTAS, EXAMES E ENCAMINHAMENTOS
${sectionOrNotInformed(conducts)}

ORIENTAÇÕES E SINAIS DE ALERTA
${sectionOrNotInformed(orientations)}

REGISTRO CRONOLÓGICO DA CONVERSA
${chronology}

PENDÊNCIAS PARA REVISÃO
- Confirmar dados de identificação, duração e cronologia dos sintomas.
- Revisar sinais vitais e exame físico antes de registrar no prontuário oficial.
- Validar lista de problemas, hipóteses e plano com a preceptoria.
- Remover falas irrelevantes e substituir campos não informados quando aplicável.

ATENÇÃO: rascunho automático baseado somente nas falas registradas. Revise integralmente antes de copiar para o prontuário oficial.`;
}

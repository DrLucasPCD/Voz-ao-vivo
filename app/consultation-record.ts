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

export type ClinicalRecordTemplate =
  | "general"
  | "psychiatry"
  | "child"
  | "woman"
  | "adolescent"
  | "older-adult";

export const CLINICAL_RECORD_TEMPLATE_LABELS: Record<ClinicalRecordTemplate, string> = {
  general: "Anamnese e exame clínico geral",
  psychiatry: "Ficha de acompanhamento - Psiquiatria",
  child: "Assistência integral à saúde da criança",
  woman: "Saúde da mulher",
  adolescent: "Primeira consulta do adolescente - SSHADESS",
  "older-adult": "Avaliação geriátrica ampla",
};

export function clinicalRecordTemplateForSpecialty(
  specialty: string,
): ClinicalRecordTemplate {
  if (specialty === "Psiquiatria") return "psychiatry";
  if (specialty === "Pediatria" || specialty === "Neonatologia") return "child";
  if (specialty === "Saúde do adolescente") return "adolescent";
  if (specialty === "Geriatria") return "older-adult";
  if (
    [
      "Ginecologia",
      "Obstetrícia",
      "Mastologia",
      "Sexologia e saúde sexual",
    ].includes(specialty)
  ) {
    return "woman";
  }
  return "general";
}

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
  const template = clinicalRecordTemplateForSpecialty(specialty);
  const dateAndContext = `Data/hora: ${formatDate(consultationStartedAt)}\nÁrea selecionada: ${specialty}\nModelo: ${CLINICAL_RECORD_TEMPLATE_LABELS[template]}`;
  const reviewNotice =
    "ATENÇÃO: rascunho automático baseado somente nas falas registradas. Revise integralmente com a preceptoria antes de usar no prontuário oficial.";

  if (template === "psychiatry") {
    const mentalState = uniqueTexts(
      turns.filter((turn) =>
        containsAny(turn.text, [
          "estado mental",
          "aparência",
          "atitude",
          "consciência",
          "atenção",
          "orientação",
          "memória",
          "pensamento",
          "linguagem",
          "humor",
          "afeto",
          "percepção",
          "alucina",
          "delírio",
          "juízo",
          "psicomotricidade",
        ]),
      ),
    );
    const risk = patientSection(patientTurns, SECTION_RULES.mental);
    return `FICHA DE ACOMPANHAMENTO DE ATIVIDADES - PSIQUIATRIA
${dateAndContext}

ATENDIMENTOS OBSERVADOS
${sectionOrNotInformed(hda)}

QUEIXAS PRINCIPAIS
${firstPatientReport ?? "Não informado na conversa."}

ANAMNESE PSIQUIÁTRICA
${sectionOrNotInformed(hda)}

EXAME DO ESTADO MENTAL
${sectionOrNotInformed(mentalState)}

AVALIAÇÃO DE RISCO
${sectionOrNotInformed(risk)}

HIPÓTESES DIAGNÓSTICAS E DIAGNÓSTICOS DIFERENCIAIS
${sectionOrNotInformed(hypotheses)}

CONDUTAS OBSERVADAS
${sectionOrNotInformed(conducts)}

PSICOEDUCAÇÃO, ORIENTAÇÕES E ENCAMINHAMENTOS
${sectionOrNotInformed(orientations)}

COMPETÊNCIAS DESENVOLVIDAS
- Anamnese psiquiátrica
- Exame do Estado Mental
- Discussão diagnóstica e diagnóstico diferencial
- Avaliação de risco
- Conduta, psicoeducação e discussão de caso

PRINCIPAL APRENDIZADO DO ATENDIMENTO
Preencher após discussão com a preceptoria.

DÚVIDAS PARA DISCUSSÃO
Preencher após revisar o caso.

REGISTRO CRONOLÓGICO DA CONVERSA
${chronology}

PRIVACIDADE
Não inserir nome, iniciais, número de prontuário, profissão ou outra informação identificável do paciente nesta ficha acadêmica.

${reviewNotice}`;
  }

  if (template === "child") {
    return `FICHA DE ASSISTÊNCIA INTEGRAL À SAÚDE DA CRIANÇA
${dateAndContext}

IDENTIFICAÇÃO E INFORMANTE
Não informado automaticamente. Preencher apenas no sistema oficial autorizado.

QUEIXA PRINCIPAL E DURAÇÃO (QPD)
${firstPatientReport ?? "Não informado na conversa."}

HISTÓRIA DA DOENÇA ATUAL (HDA)
${sectionOrNotInformed(hda)}

INTERROGATÓRIO SINTOMATOLÓGICO
${sectionOrNotInformed(hda.slice(1))}

PRÉ-NATAL, PARTO E PERÍODO NEONATAL
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.pediatric))}

ALIMENTAÇÃO E AMAMENTAÇÃO
${sectionOrNotInformed(patientSection(patientTurns, ["amament", "mamou", "desmame", "aliment", "dieta", "refeição"]))}

CRESCIMENTO E DESENVOLVIMENTO
${sectionOrNotInformed(patientSection(patientTurns, ["crescimento", "desenvolvimento", "peso", "altura", "fala", "andar", "escola"]))}

IMUNIZAÇÕES
${sectionOrNotInformed(patientSection(patientTurns, ["vacina", "imunização", "cartão vacinal"]))}

MEDICAÇÕES, ALERGIAS E DOENÇAS ANTERIORES
${sectionOrNotInformed([...patientSection(patientTurns, SECTION_RULES.medications), ...patientSection(patientTurns, SECTION_RULES.history)])}

HÁBITOS, HISTÓRIA FAMILIAR E CONDIÇÕES DOMÉSTICAS
${sectionOrNotInformed([...patientSection(patientTurns, SECTION_RULES.habits), ...patientSection(patientTurns, SECTION_RULES.family)])}

EXAME FÍSICO E DADOS ANTROPOMÉTRICOS
${sectionOrNotInformed(examination)}

HIPÓTESES DIAGNÓSTICAS
${sectionOrNotInformed(hypotheses)}

CONDUTAS E ORIENTAÇÕES
${sectionOrNotInformed([...conducts, ...orientations])}

REGISTRO CRONOLÓGICO DA CONVERSA
${chronology}

${reviewNotice}`;
  }

  if (template === "woman") {
    return `FICHA DE SAÚDE DA MULHER
${dateAndContext}

IDENTIFICAÇÃO E PERFIL SOCIODEMOGRÁFICO
Não informado automaticamente. Preencher apenas no sistema oficial autorizado.

QUEIXA PRINCIPAL E HISTÓRIA DA DOENÇA ATUAL
${sectionOrNotInformed(hda)}

ANTECEDENTES TOCOGINECOLÓGICOS
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.reproductive))}

SINTOMAS GINECOLÓGICOS, URINÁRIOS, MAMÁRIOS E SEXUAIS
${sectionOrNotInformed(patientSection(patientTurns, ["corrimento", "prurido", "coceira", "sangramento", "dismenorreia", "dor pélvica", "dispareunia", "mama", "mamilo", "urina", "libido", "ressecamento"]))}

ANTECEDENTES PESSOAIS, FAMILIARES E CIRÚRGICOS
${sectionOrNotInformed([...patientSection(patientTurns, SECTION_RULES.history), ...patientSection(patientTurns, SECTION_RULES.family)])}

MEDICAÇÕES E ALERGIAS
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.medications))}

SINAIS VITAIS E EXAME FÍSICO GERAL
${sectionOrNotInformed(examination)}

EXAME DAS MAMAS, ABDOME E EXAME GINECOLÓGICO
${sectionOrNotInformed(uniqueTexts(turns.filter((turn) => containsAny(turn.text, ["mama", "abdome", "vulva", "vagina", "colo", "útero", "ovário", "toque", "especular", "prolapso", "períneo", "retal"]))))}

HIPÓTESES DIAGNÓSTICAS
${sectionOrNotInformed(hypotheses)}

CONDUTA MEDICAMENTOSA, EXAMES E ENCAMINHAMENTOS
${sectionOrNotInformed(conducts)}

ORIENTAÇÕES
${sectionOrNotInformed(orientations)}

REGISTRO CRONOLÓGICO DA CONVERSA
${chronology}

${reviewNotice}`;
  }

  if (template === "adolescent") {
    return `FICHA DE PRIMEIRA CONSULTA DO ADOLESCENTE
${dateAndContext}

IDENTIFICAÇÃO, ACOMPANHANTE E CONTEXTO
Não informado automaticamente. Preencher apenas no sistema oficial autorizado.

MOTIVO DA CONSULTA, QPD E HDA
${sectionOrNotInformed(hda)}

INTERROGATÓRIO SINTOMATOLÓGICO
${sectionOrNotInformed(hda.slice(1))}

HISTÓRIA PREGRESSA, NASCIMENTO E IMUNIZAÇÕES
${sectionOrNotInformed([...patientSection(patientTurns, SECTION_RULES.history), ...patientSection(patientTurns, SECTION_RULES.pediatric)])}

ALIMENTAÇÃO, CRESCIMENTO, DESENVOLVIMENTO E PUBERDADE
${sectionOrNotInformed(patientSection(patientTurns, ["aliment", "dieta", "crescimento", "desenvolvimento", "puberdade", "menarca", "espermarca", "tanner"]))}

HISTÓRICO FAMILIAR E CONDIÇÕES SOCIOECONÔMICAS
${sectionOrNotInformed([...patientSection(patientTurns, SECTION_RULES.family), ...patientSection(patientTurns, SECTION_RULES.habits)])}

TRIAGEM PSICOSSOCIAL SSHADESS
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.adolescent))}

SAÚDE MENTAL, AUTOLESÃO E RISCO DE SUICÍDIO
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.mental))}

EXAME FÍSICO, TANNER E EXAME DO ESTADO MENTAL
${sectionOrNotInformed(examination)}

HIPÓTESES DIAGNÓSTICAS ORDENADAS
${sectionOrNotInformed(hypotheses)}

MANEJO, ORIENTAÇÕES E ENCAMINHAMENTOS
${sectionOrNotInformed([...conducts, ...orientations])}

REGISTRO CRONOLÓGICO DA CONVERSA
${chronology}

${reviewNotice}`;
  }

  if (template === "older-adult") {
    return `FICHA DE AVALIAÇÃO GERIÁTRICA AMPLA
${dateAndContext}

IDENTIFICAÇÃO E CONTEXTO SOCIAL
Não informado automaticamente. Preencher apenas no sistema oficial autorizado.

QUEIXA PRINCIPAL E HISTÓRIA ATUAL
${sectionOrNotInformed(hda)}

MEDICAMENTOS, DOSES, HORÁRIOS E ALERGIAS
${sectionOrNotInformed(patientSection(patientTurns, SECTION_RULES.medications))}

ANTECEDENTES, INTERNAÇÕES, CIRURGIAS, FRATURAS E HÁBITOS
${sectionOrNotInformed([...patientSection(patientTurns, SECTION_RULES.history), ...patientSection(patientTurns, SECTION_RULES.habits)])}

FUNCIONALIDADE - AIVD DE LAWTON E ABVD DE KATZ
${sectionOrNotInformed(patientSection(patientTurns, ["telefone", "transporte", "compras", "refeição", "casa", "roupa", "remédio", "finanças", "alimentação", "vestir", "banho", "higiene", "transferência", "continência"]))}

FRAGILIDADE, ATIVIDADE FÍSICA E QUEDAS
${sectionOrNotInformed(patientSection(patientTurns, ["fadiga", "escada", "caminhar", "doenças", "perda de peso", "atividade física", "queda", "fragilidade"]))}

COGNIÇÃO, SONO E HUMOR
${sectionOrNotInformed(patientSection(patientTurns, ["memória", "esquec", "raciocínio", "orientação", "palavra", "sono", "cochilo", "ronco", "pesadelo", "humor", "triste", "ansioso"]))}

NUTRIÇÃO, DEGLUTIÇÃO, TGI E TGU
${sectionOrNotInformed(patientSection(patientTurns, ["dieta", "proteína", "carne", "leite", "água", "disfagia", "intestino", "urina", "continência"]))}

VISÃO, AUDIÇÃO, DENTIÇÃO, SUPORTE SOCIAL, VACINAS E PREVENÇÃO
${sectionOrNotInformed(patientSection(patientTurns, ["visão", "audição", "dente", "odont", "suporte", "cuidador", "vacina", "colonoscopia", "mamografia", "psa", "densitometria"]))}

EXAME FÍSICO
${sectionOrNotInformed(examination)}

LISTA DE PROBLEMAS
${sectionOrNotInformed(hda)}

PLANO TERAPÊUTICO, CONDUTAS E ORIENTAÇÕES
${sectionOrNotInformed([...conducts, ...orientations])}

REGISTRO CRONOLÓGICO DA CONVERSA
${chronology}

${reviewNotice}`;
  }

  return `PRONTUÁRIO DA CONSULTA - RASCUNHO PARA REVISÃO
${dateAndContext}

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

${reviewNotice}`;
}

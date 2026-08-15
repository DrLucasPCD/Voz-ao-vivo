# Clara — Voz ao vivo

Aplicativo web de comunicação assistida para ajudar um médico com alteração de
dicção a conduzir consultas. A Clara reconhece a fala, permite corrigir a
pergunta e a reproduz com voz clara para o paciente.

## Recursos

- reconhecimento de fala em português do Brasil;
- reprodução da pergunta com a voz neural Piper Faber em português do Brasil;
- síntese local no navegador, com voz nativa do aparelho como alternativa;
- pelo menos 100 perguntas rápidas em cada especialidade;
- prioridade dinâmica conforme as respostas ouvidas do paciente;
- separação automática entre usuário, paciente e equipe/preceptoria;
- reprodução automática somente da fala identificada como sendo do usuário;
- proteção antieco para ignorar o áudio emitido pelo próprio app;
- biblioteca de perguntas organizada por dezenas de especialidades;
- contexto da especialidade aplicado ao reconhecimento de voz;
- análise de até cinco alternativas de transcrição quando disponíveis;
- contextualização nativa de termos em navegadores compatíveis;
- comparação acústica local com as amostras pessoais de voz;
- vocabulário clínico e correções pessoais aplicados no próprio navegador;
- funcionamento sem API paga e sem chave secreta;
- memória local das correções do usuário, mesmo sem login;
- sincronização opcional entre dispositivos com login Google ou Apple;
- áudios pequenos e privados sincronizados no Firestore gratuito;
- gravação de áudio associada ao texto correto;
- exportação da base de voz em ZIP;
- interface responsiva e acessível.

Sem login, as correções e gravações ficam somente no navegador. Ao entrar com
Google ou Apple, o perfil é sincronizado no projeto Firebase `voz-ao-vivo`, em
caminhos isolados pelo identificador da conta.

## Executar localmente

Requer Node.js 22 ou mais recente.

```bash
npm install
npm run dev
```

Abra `http://localhost:3000` no Chrome ou Edge e permita o acesso ao microfone.

## Verificação

```bash
npm run lint
npm test
```

## Hospedar no Netlify

O projeto usa Next.js e inclui o arquivo `netlify.toml`. No Netlify:

1. Selecione **Add new project → Import an existing project**.
2. Conecte o repositório `DrLucasPCD/Voz-ao-vivo`.
3. Confirme o comando de build `npm run build` e a pasta `.next`.
4. Publique o projeto.

O Netlify detecta o Next.js automaticamente. Não é necessário fixar uma versão
do adaptador do Netlify.

### Reconhecimento sem cobrança

O app não usa OpenAI nem outra API paga. A primeira transcrição vem do recurso
de voz do navegador. Em seguida, a Clara compara localmente ritmo, duração,
energia e faixas de frequência com as frases treinadas. Para reduzir falsos
positivos, a comparação acústica só substitui o resultado quando também existe
apoio do texto reconhecido ou duas gravações da mesma frase.

Grave cada pergunta importante pelo menos duas vezes. A comparação acústica
funciona melhor para frases treinadas; fala livre ainda depende da qualidade do
reconhecimento oferecido pelo navegador.

Com três ou mais amostras, a Clara cria também um perfil estatístico da voz do
usuário. Cada turno do microfone é classificado automaticamente como **minha
fala**, **paciente** ou **equipe/preceptoria**. Vozes diferentes da cadastrada
são separadas pelo conteúdo: relatos em primeira pessoa alimentam o contexto do
paciente; discussão de hipótese, exame e conduta vai para o contexto da equipe.
A interface permite corrigir o rótulo quando necessário.

Quando o turno é identificado como fala do usuário, a frase é emitida
automaticamente em voz clara. O reconhecimento fica suspenso durante a síntese,
descarta ecos semelhantes e só reabre o microfone depois que o áudio termina.
Falas do paciente e da equipe nunca são reproduzidas automaticamente.

### Voz neural Piper Faber

A voz principal é o modelo
[`Trelis/piper-pt-br-faber-medium`](https://huggingface.co/Trelis/piper-pt-br-faber-medium),
uma voz masculina brasileira em ONNX, com amostragem de 22,05 kHz. O modelo tem
aproximadamente 63 MB; considerando ONNX Runtime, fonemizador e recursos WASM,
a primeira preparação pode transferir cerca de 95 MB.

O download só começa quando o usuário toca em **Baixar voz** ou pede a primeira
reprodução. Os arquivos ficam no armazenamento privado do navegador e são
reaproveitados nas próximas consultas no mesmo dispositivo. A geração acontece
em um Web Worker para não travar a interface. Depois que os componentes estão
armazenados, o texto sintetizado não é enviado a um serviço remoto de voz.

Se o navegador não oferecer armazenamento privado, WebAssembly suficiente ou
memória para o modelo, a Clara muda automaticamente para a voz em português do
próprio aparelho. O modelo Faber está publicado sob CC0; o adaptador web Piper e
o ONNX Runtime usam licenças permissivas.

## Ativar a sincronização Firebase

A configuração pública do app Firebase já está no código. Antes de usar a
sincronização em produção, faça estas etapas no [Console do Firebase](https://console.firebase.google.com/):

1. Em **Authentication → Sign-in method**, ative o provedor **Google**.
2. Crie somente um banco **Cloud Firestore** no projeto `voz-ao-vivo`. Não é
   necessário ativar Cloud Storage nem cadastrar cartão.
3. Em **Authentication → Settings → Authorized domains**, adicione o domínio
   final do site no Netlify, sem `https://`.
4. Instale a CLI e publique as regras privadas incluídas no repositório:

```bash
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules,firestore:indexes
```

As regras permitem que cada usuário autenticado acesse apenas
`users/{seu-uid}/...`, limitam cada áudio a 700 KiB e impedem a indexação dos
bytes. Não publique o banco com regras abertas de modo de teste. Para produção,
também é recomendável ativar o Firebase App Check.

No plano Spark, o Firestore oferece uma cota gratuita e não exige forma de
pagamento. Se a cota for ultrapassada, a sincronização para até o ciclo seguinte
em vez de gerar cobrança. O app continua guardando as amostras localmente.

O Analytics não é inicializado neste app, para evitar telemetria desnecessária
em um fluxo com dados de voz potencialmente sensíveis.

### Login no celular com Google

No celular, o app usa diretamente o redirecionamento recomendado pelo Firebase.
Em computadores, tenta primeiro o popup e usa redirecionamento se o navegador o
bloquear. O `netlify.toml` já encaminha `/__/auth/*` ao Firebase para permitir o
fluxo no mesmo domínio.

O popup funciona com o `authDomain` padrão do Firebase e não requer configuração
adicional no Netlify. Se quiser ativar o redirecionamento no mesmo domínio, crie
no Netlify a variável `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` com apenas o domínio do
site. Adicione esse domínio aos domínios autorizados do Firebase e registre
`https://SEU-DOMINIO/__/auth/handler` como URI autorizada no cliente OAuth do
Google. Essa configuração adicional evita limitações de armazenamento de
terceiros em alguns navegadores móveis.

### Ativar login com Apple

O código do provedor Apple já está incluído, mas o botão só aparece depois da
configuração obrigatória:

1. Tenha uma assinatura ativa do **Apple Developer Program**.
2. No portal Apple Developer, crie um **Service ID**, associe o site e registre
   `https://voz-ao-vivo.firebaseapp.com/__/auth/handler` como Return URL. Crie
   também a chave privada do Sign in with Apple e anote o Team ID e o Key ID.
3. No Firebase, em **Authentication → Sign-in method → Apple**, informe o
   Service ID, Team ID, Key ID e a chave privada e ative o provedor.
4. No Netlify, defina `NEXT_PUBLIC_ENABLE_APPLE_SIGN_IN=true` e faça um novo
   deploy.

Se `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` apontar para um domínio próprio, esse
domínio e `https://SEU-DOMINIO/__/auth/handler` também precisam ser verificados
e liberados na Apple e no Firebase. Contas Apple podem ocultar o e-mail, mas a
sincronização continua funcionando porque os dados são isolados pelo UID da
conta no Firebase.

## Como o reconhecimento melhora

A especialidade selecionada prioriza o vocabulário clínico correspondente. O
app compara alternativas do reconhecimento, aplica as correções já ensinadas e
mantém frases que não combinam com a biblioteca como fala livre.

Cada gravação gera uma assinatura acústica compacta. Durante a consulta, a
assinatura da fala atual é comparada com as amostras no dispositivo. As
correções textuais aprendidas também são reaplicadas automaticamente.

Cada especialidade possui entre 105 e 111 perguntas rápidas. O texto reconhecido
como resposta do paciente ativa regras locais de prioridade: termos como dor,
febre, falta de ar, sangramento, trauma e medicamentos fazem as perguntas de
caracterização correspondentes subirem para o início da lista. Falas da equipe
ficam separadas e não alteram essa ordem.

Esse método gratuito é personalizado para frases treinadas, mas não é um modelo
de fala completo permanentemente treinado. Portanto, não é possível garantir
100% de acerto para toda fala.

## Privacidade clínica

Este protótipo é uma ferramenta de comunicação e não fornece diagnóstico ou
conduta médica. Evite incluir dados identificáveis do paciente nas frases de
treinamento. Em uso clínico, valide os requisitos de privacidade, segurança e
conformidade aplicáveis à sua instituição. Firebase e Netlify, isoladamente,
não garantem conformidade regulatória para dados clínicos. A comparação
personalizada ocorre no aparelho; com login, as amostras são sincronizadas no
Firestore privado da conta.

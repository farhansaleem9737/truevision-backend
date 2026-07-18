// Backend/data/legal.js
//
// Structured legal documents served at GET /api/legal/terms and
// GET /api/legal/privacy. Content is modelled as ordered sections, each with a
// heading and a list of typed blocks so the client can render rich text
// (paragraphs, bullet lists, inline links) without parsing HTML/markdown.
//
// Block types:
//   { type: 'paragraph', text }
//   { type: 'list', items: [string] }
//   { type: 'link', label, url }
//
// Bump `version` + `lastUpdated` whenever the wording changes — the client
// shows both and can prompt users to re-accept on a version bump.

const COMPANY = 'TrueVision';
const CONTACT_EMAIL = 'legal@truevision.app';
const WEBSITE = 'https://truevision.app';

const terms = {
  document: 'terms',
  title: 'Terms of Service',
  version: '1.0.0',
  lastUpdated: '2026-07-01',
  effectiveDate: '2026-07-01',
  intro:
    `Welcome to ${COMPANY}. These Terms of Service ("Terms") govern your access to and use of the ${COMPANY} mobile application and related services (the "Service"). By using the Service you agree to these Terms.`,
  sections: [
    {
      id: 'acceptance',
      heading: '1. Acceptance of Terms',
      body: [
        { type: 'paragraph', text: `By creating an account or using ${COMPANY}, you confirm that you are at least 13 years old and that you accept these Terms and our Privacy Policy. If you do not agree, do not use the Service.` },
      ],
    },
    {
      id: 'accounts',
      heading: '2. Your Account',
      body: [
        { type: 'paragraph', text: 'You are responsible for safeguarding your account credentials and for all activity that occurs under your account.' },
        { type: 'list', items: [
          'Provide accurate registration information and keep it up to date.',
          'Do not share your password or let others access your account.',
          'Notify us immediately of any unauthorized use.',
        ] },
      ],
    },
    {
      id: 'content',
      heading: '3. Your Content',
      body: [
        { type: 'paragraph', text: `You retain ownership of the videos, comments and other content you post. By posting, you grant ${COMPANY} a worldwide, non-exclusive, royalty-free license to host, display and distribute that content solely to operate and improve the Service.` },
        { type: 'paragraph', text: 'You are solely responsible for your content and confirm you have the rights necessary to post it.' },
      ],
    },
    {
      id: 'conduct',
      heading: '4. Acceptable Use',
      body: [
        { type: 'paragraph', text: 'To keep TrueVision safe and trustworthy, you agree not to:' },
        { type: 'list', items: [
          'Post unlawful, hateful, harassing, or misleading content.',
          'Impersonate others or misrepresent your affiliation.',
          'Attempt to circumvent moderation, rate limits, or security controls.',
          'Upload malware or scrape the Service without permission.',
        ] },
      ],
    },
    {
      id: 'moderation',
      heading: '5. Moderation & AI Labels',
      body: [
        { type: 'paragraph', text: 'TrueVision uses automated systems and human review to label content as fact, news, or opinion and to remove content that violates these Terms. Labels are provided for guidance and may not be perfectly accurate.' },
      ],
    },
    {
      id: 'termination',
      heading: '6. Suspension & Termination',
      body: [
        { type: 'paragraph', text: 'We may suspend or terminate your access if you violate these Terms or create risk for the Service or other users. You may delete your account at any time.' },
      ],
    },
    {
      id: 'disclaimer',
      heading: '7. Disclaimers & Liability',
      body: [
        { type: 'paragraph', text: 'The Service is provided "as is" without warranties of any kind. To the maximum extent permitted by law, TrueVision is not liable for indirect or consequential damages arising from your use of the Service.' },
      ],
    },
    {
      id: 'changes',
      heading: '8. Changes to These Terms',
      body: [
        { type: 'paragraph', text: 'We may update these Terms from time to time. Material changes will be announced in the app. Continued use after changes take effect constitutes acceptance.' },
      ],
    },
    {
      id: 'contact',
      heading: '9. Contact Us',
      body: [
        { type: 'paragraph', text: 'Questions about these Terms? Reach us at:' },
        { type: 'link', label: CONTACT_EMAIL, url: `mailto:${CONTACT_EMAIL}` },
        { type: 'link', label: WEBSITE, url: WEBSITE },
      ],
    },
  ],
};

const privacy = {
  document: 'privacy',
  title: 'Privacy Policy',
  version: '1.0.0',
  lastUpdated: '2026-07-01',
  effectiveDate: '2026-07-01',
  intro:
    `This Privacy Policy explains what information ${COMPANY} collects, how we use it, and the choices you have. We designed ${COMPANY} to collect only what we need to run the Service.`,
  sections: [
    {
      id: 'collect',
      heading: 'Information We Collect',
      body: [
        { type: 'list', items: [
          'Account data: name, username, email, country, and profile photo.',
          'Content: videos, comments, messages, likes, saves and shares.',
          'Usage: watched videos, searches, and interactions used to personalize your feed.',
          'Device: app version, device model, and language for diagnostics.',
        ] },
      ],
    },
    {
      id: 'use',
      heading: 'How We Use Information',
      body: [
        { type: 'list', items: [
          'Operate core features like your feed, chat, and notifications.',
          'Moderate content and enforce our Terms of Service.',
          'Personalize recommendations (you can limit this in Content Preferences).',
          'Keep your account secure and prevent abuse.',
        ] },
      ],
    },
    {
      id: 'sharing',
      heading: 'How We Share Information',
      body: [
        { type: 'paragraph', text: 'We do not sell your personal information. We share data only with service providers who help us run the Service (for example, cloud media hosting and push notifications), and when required by law.' },
      ],
    },
    {
      id: 'choices',
      heading: 'Your Privacy Choices',
      body: [
        { type: 'list', items: [
          'Make your account private so only approved followers see your videos.',
          'Hide your online status and followers list.',
          'Control who can message and comment.',
          'Block accounts and clear your activity history at any time.',
        ] },
      ],
    },
    {
      id: 'retention',
      heading: 'Data Retention',
      body: [
        { type: 'paragraph', text: 'We keep your information while your account is active. When you delete your account, we remove or anonymize your personal data, except where we must retain it for legal reasons.' },
      ],
    },
    {
      id: 'security',
      heading: 'Security',
      body: [
        { type: 'paragraph', text: 'We use encryption in transit, hashed passwords, and access controls. No system is perfectly secure, so please use a strong password and enable two-factor authentication.' },
      ],
    },
    {
      id: 'children',
      heading: "Children's Privacy",
      body: [
        { type: 'paragraph', text: 'TrueVision is not directed to children under 13. We do not knowingly collect data from children under 13.' },
      ],
    },
    {
      id: 'contact',
      heading: 'Contact & Requests',
      body: [
        { type: 'paragraph', text: 'To access, correct, or delete your data, or for any privacy question, contact:' },
        { type: 'link', label: 'privacy@truevision.app', url: 'mailto:privacy@truevision.app' },
        { type: 'link', label: WEBSITE, url: WEBSITE },
      ],
    },
  ],
};

module.exports = { terms, privacy };

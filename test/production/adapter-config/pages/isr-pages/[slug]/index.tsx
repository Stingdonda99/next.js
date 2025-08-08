export function getStaticPaths() {
  return {
    paths: [
      {
        params: { slug: 'first' },
      },
      {
        params: { slug: 'second' },
      },
      {
        params: { slug: 'not-found' },
      },
    ],
    fallback: 'blocking',
  }
}

export function getStaticProps({ params }) {
  return {
    props: {
      params,
      now: Date.now(),
    },
    revalidate: params.slug === 'first' ? 60 : undefined,
  }
}

export default function Page() {
  return (
    <>
      <p>/isr-pages/[slug]</p>
      <p>now: {Date.now()}</p>
    </>
  )
}

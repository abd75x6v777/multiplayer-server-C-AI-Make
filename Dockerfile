FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ cmake make libboost-dev nlohmann-json3-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY CMakeLists.txt server.cpp ./
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF \
    && cmake --build build --parallel 1

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system game && useradd --system --gid game --no-create-home game
WORKDIR /app
COPY --from=build /src/build/multiplayer_server /app/multiplayer_server
USER game
ENV PORT=8080
EXPOSE 8080
CMD ["/app/multiplayer_server"]
